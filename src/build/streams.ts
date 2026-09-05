/**
 * CanonicalEvent stream → public SSE format emitters.
 * Three public formats: OpenAI Chat Completions chunks, Anthropic Messages events,
 * OpenAI Responses events.
 */

import type { CanonicalEvent, CanonicalUsage } from "../canonical";
import { TEXT_ENCODER } from "../util";

export interface EmitContext {
  model: string;
  /** id of the completion (generated once per request) */
  id: string;
}

export function sseLine(event: string | undefined, data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return TEXT_ENCODER.encode(event ? `event: ${event}\ndata: ${payload}\n\n` : `data: ${payload}\n\n`);
}

function toOpenAiUsage(usage: CanonicalUsage): Record<string, unknown> {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    prompt_tokens_details: { cached_tokens: usage.cachedTokens ?? 0 },
    completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
  };
}

function toAnthropicUsage(usage: CanonicalUsage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
  if (usage.cachedTokens !== undefined) out["cache_read_input_tokens"] = usage.cachedTokens;
  return out;
}

// ---------- OpenAI Chat Completions chunks ----------

export function createChatEmitter(ctx: EmitContext): (event: CanonicalEvent) => Uint8Array[] {
  let roleSent = false;
  let pendingUsage: CanonicalUsage | undefined;
  let pendingCost: number | string | undefined;
  let ended = false;

  return (event: CanonicalEvent): Uint8Array[] => {
    const out: Uint8Array[] = [];
    const base = { id: ctx.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: ctx.model };
    const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}) => {
      out.push(
        sseLine(
          undefined,
          {
            ...base,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...extra,
          },
        ),
      );
    };

    switch (event.type) {
      case "start":
        roleSent = false;
        ended = false;
        pendingUsage = undefined;
        pendingCost = undefined;
        break;
      case "reasoning_delta":
        if (!roleSent) {
          chunk({ role: "assistant", content: null, reasoning_content: event.delta });
          roleSent = true;
        } else {
          chunk({ content: null, reasoning_content: event.delta });
        }
        break;
      case "text_delta":
        if (!roleSent) {
          chunk({ role: "assistant", content: event.delta });
          roleSent = true;
        } else {
          chunk({ content: event.delta });
        }
        break;
      case "tool_call_start":
        if (!roleSent) {
          chunk({ role: "assistant", content: null, tool_calls: [{ index: event.index, id: event.id, type: "function", function: { name: event.name, arguments: "" } }] });
          roleSent = true;
        } else {
          chunk({ tool_calls: [{ index: event.index, id: event.id, type: "function", function: { name: event.name, arguments: "" } }] });
        }
        break;
      case "tool_call_delta":
        chunk({ tool_calls: [{ index: event.index, function: { arguments: event.argsDelta } }] });
        break;
      case "tool_call_end":
        break;
      case "usage":
        pendingUsage = event.usage;
        pendingCost = event.cost;
        break;
      case "stop": {
        if (ended) break;
        ended = true;
        const finish =
          event.stopReason === "max_tokens"
            ? "length"
            : event.stopReason === "tool_use"
              ? "tool_calls"
              : event.stopReason === "stop_sequence"
                ? "content_filter"
                : "stop";
        const extra: Record<string, unknown> = {};
        if (pendingUsage) extra["usage"] = toOpenAiUsage(pendingUsage);
        if (pendingCost !== undefined) extra["cost"] = pendingCost;
        chunk({}, finish, extra);
        out.push(sseLine(undefined, "[DONE]"));
        break;
      }
      case "error":
        out.push(
          sseLine(undefined, {
            error: { message: event.error.message, type: event.error.type, code: event.error.type },
          }),
        );
        // clients keyed on finish_reason/[DONE] must still see a terminated stream
        if (!ended) {
          ended = true;
          chunk({}, "stop");
          out.push(sseLine(undefined, "[DONE]"));
        }
        break;
    }
    return out;
  };
}

// ---------- Anthropic Messages events ----------

export function createAnthropicEmitter(ctx: EmitContext): (event: CanonicalEvent) => Uint8Array[] {
  let textBlockOpen = false;
  let thinkingBlockOpen = false;
  let nextBlockIndex = 0;
  let pendingUsage: CanonicalUsage | undefined;
  let pendingCost: number | string | undefined;
  let ended = false;
  let messageStarted = false;
  const toolBlockIndex = new Map<number, number>();

  return (event: CanonicalEvent): Uint8Array[] => {
    const out: Uint8Array[] = [];
    const closeTextBlock = () => {
      if (textBlockOpen) {
        out.push(sseLine("content_block_stop", { type: "content_block_stop", index: nextBlockIndex - 1 }));
        textBlockOpen = false;
      }
    };
    const closeThinkingBlock = () => {
      if (thinkingBlockOpen) {
        out.push(sseLine("content_block_stop", { type: "content_block_stop", index: nextBlockIndex - 1 }));
        thinkingBlockOpen = false;
      }
    };
    const emitMessageStart = () => {
      out.push(
        sseLine("message_start", {
          type: "message_start",
          message: {
            id: ctx.id,
            type: "message",
            role: "assistant",
            model: ctx.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }),
      );
    };
    // auto-start if the upstream stream never sent an explicit start
    if (
      !messageStarted &&
      (event.type === "text_delta" || event.type === "reasoning_delta" || event.type === "tool_call_start")
    ) {
      messageStarted = true;
      emitMessageStart();
    }

    switch (event.type) {
      case "start": {
        if (messageStarted) break;
        messageStarted = true;
        emitMessageStart();
        break;
      }
      case "reasoning_delta": {
        if (!thinkingBlockOpen) {
          closeTextBlock();
          out.push(sseLine("content_block_start", { type: "content_block_start", index: nextBlockIndex, content_block: { type: "thinking", thinking: "" } }));
          nextBlockIndex += 1;
          thinkingBlockOpen = true;
        }
        out.push(sseLine("content_block_delta", { type: "content_block_delta", index: nextBlockIndex - 1, delta: { type: "thinking_delta", thinking: event.delta } }));
        break;
      }
      case "text_delta": {
        if (!textBlockOpen) {
          closeThinkingBlock();
          out.push(sseLine("content_block_start", { type: "content_block_start", index: nextBlockIndex, content_block: { type: "text", text: "" } }));
          nextBlockIndex += 1;
          textBlockOpen = true;
        }
        out.push(sseLine("content_block_delta", { type: "content_block_delta", index: nextBlockIndex - 1, delta: { type: "text_delta", text: event.delta } }));
        break;
      }
      case "tool_call_start": {
        closeTextBlock();
        closeThinkingBlock();
        toolBlockIndex.set(event.index, nextBlockIndex);
        out.push(
          sseLine("content_block_start", {
            type: "content_block_start",
            index: nextBlockIndex,
            content_block: { type: "tool_use", id: event.id, name: event.name, input: {} },
          }),
        );
        nextBlockIndex += 1;
        break;
      }
      case "tool_call_delta": {
        out.push(
          sseLine("content_block_delta", {
            type: "content_block_delta",
            index: toolBlockIndex.get(event.index) ?? nextBlockIndex - 1,
            delta: { type: "input_json_delta", partial_json: event.argsDelta },
          }),
        );
        break;
      }
      case "tool_call_end": {
        out.push(sseLine("content_block_stop", { type: "content_block_stop", index: toolBlockIndex.get(event.index) ?? nextBlockIndex - 1 }));
        break;
      }
      case "usage":
        pendingUsage = event.usage;
        pendingCost = event.cost;
        break;
      case "stop": {
        if (ended) break;
        ended = true;
        closeTextBlock();
        closeThinkingBlock();
        const usage = pendingUsage ?? { inputTokens: 0, outputTokens: 0 };
        const messageDelta: Record<string, unknown> = {
          type: "message_delta",
          delta: {
            stop_reason: event.stopReason === "max_tokens" ? "max_tokens" : event.stopReason === "tool_use" ? "tool_use" : event.stopReason === "stop_sequence" ? "stop_sequence" : "end_turn",
            stop_sequence: null,
          },
          usage: toAnthropicUsage(usage),
        };
        if (pendingCost !== undefined) messageDelta["cost"] = pendingCost;
        out.push(sseLine("message_delta", messageDelta));
        out.push(sseLine("message_stop", { type: "message_stop" }));
        break;
      }
      case "error": {
        if (ended) break;
        ended = true;
        const anthropicType = /^(rate_limit_error|authentication_error|permission_error|not_found_error|invalid_request_error|overloaded_error|api_error)$/.test(event.error.type)
          ? event.error.type
          : "api_error";
        out.push(
          sseLine("error", {
            type: "error",
            error: { type: anthropicType, message: event.error.message },
          }),
        );
        break;
      }
    }
    return out;
  };
}

// ---------- OpenAI Responses events ----------

export function createResponsesEmitter(ctx: EmitContext): (event: CanonicalEvent) => Uint8Array[] {
  let seq = 0;
  let responseStarted = false;
  let textItemOpen = false;
  let reasoningItemOpen = false;
  let nextOutputIndex = 0;
  let pendingUsage: CanonicalUsage | undefined;
  let pendingCost: number | string | undefined;
  let ended = false;
  let lastCallId = "";
  let lastCallName = "";
  let lastCallArgs = "";
  // assembled output items for response.completed (openai-node reads these)
  const completedOutput: Record<string, unknown>[] = [];
  let textAccum = "";
  let reasoningAccum = "";

  const baseResponse = (status: string) => ({
    id: ctx.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: ctx.model,
    output: [],
    error: null,
    incomplete_details: null,
    usage: null,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
  });

  const ev = (type: string, extra: Record<string, unknown> = {}): Uint8Array =>
    sseLine(type, { type, sequence_number: seq++, ...extra });

  return (event: CanonicalEvent): Uint8Array[] => {
    const out: Uint8Array[] = [];
    const closeTextItem = () => {
      if (textItemOpen) {
        textItemOpen = false;
        const messageItem = {
          type: "message",
          id: `msg_${ctx.id}_${nextOutputIndex - 1}`,
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text: textAccum, annotations: [] }],
        };
        completedOutput.push(messageItem);
        out.push(ev("response.output_text.done", { output_index: nextOutputIndex - 1, content_index: 0, text: textAccum }));
        out.push(ev("response.output_item.done", { output_index: nextOutputIndex - 1, item: messageItem }));
        textAccum = "";
      }
    };
    const closeReasoningItem = () => {
      if (reasoningItemOpen) {
        reasoningItemOpen = false;
        const reasoningItem = {
          type: "reasoning",
          id: `rs_${ctx.id}_${nextOutputIndex - 1}`,
          summary: reasoningAccum ? [{ type: "summary_text", text: reasoningAccum }] : [],
        };
        completedOutput.push(reasoningItem);
        out.push(ev("response.output_item.done", { output_index: nextOutputIndex - 1, item: reasoningItem }));
        reasoningAccum = "";
      }
    };

    // auto-start if the upstream stream never sent an explicit start
    if (
      !responseStarted &&
      (event.type === "text_delta" || event.type === "reasoning_delta" || event.type === "tool_call_start")
    ) {
      responseStarted = true;
      out.push(ev("response.created", { response: baseResponse("in_progress") }));
    }

    switch (event.type) {
      case "start": {
        if (responseStarted) break;
        responseStarted = true;
        out.push(ev("response.created", { response: baseResponse("in_progress") }));
        break;
      }
      case "reasoning_delta": {
        if (!reasoningItemOpen) {
          closeTextItem();
          out.push(ev("response.output_item.added", { output_index: nextOutputIndex, item: { type: "reasoning", id: `rs_${ctx.id}_${nextOutputIndex}`, summary: [] } }));
          reasoningItemOpen = true;
          nextOutputIndex += 1;
        }
        reasoningAccum += event.delta;
        out.push(ev("response.reasoning_summary_text.delta", { output_index: nextOutputIndex - 1, summary_index: 0, delta: event.delta }));
        break;
      }
      case "text_delta": {
        if (!textItemOpen) {
          closeReasoningItem();
          out.push(
            ev("response.output_item.added", {
              output_index: nextOutputIndex,
              item: { type: "message", id: `msg_${ctx.id}_${nextOutputIndex}`, status: "in_progress", role: "assistant", content: [] },
            }),
          );
          out.push(
            ev("response.content_part.added", {
              output_index: nextOutputIndex,
              content_index: 0,
              part: { type: "output_text", text: "", annotations: [] },
            }),
          );
          textItemOpen = true;
          nextOutputIndex += 1;
        }
        textAccum += event.delta;
        out.push(ev("response.output_text.delta", { output_index: nextOutputIndex - 1, content_index: 0, delta: event.delta }));
        break;
      }
      case "tool_call_start": {
        closeTextItem();
        closeReasoningItem();
        lastCallId = event.id;
        lastCallName = event.name;
        lastCallArgs = "";
        out.push(
          ev("response.output_item.added", {
            output_index: nextOutputIndex,
            item: { type: "function_call", id: `fc_${ctx.id}_${event.index}`, call_id: event.id, name: event.name, arguments: "", status: "in_progress" },
          }),
        );
        nextOutputIndex += 1;
        break;
      }
      case "tool_call_delta": {
        lastCallArgs += event.argsDelta;
        out.push(ev("response.function_call_arguments.delta", { output_index: nextOutputIndex - 1, delta: event.argsDelta }));
        break;
      }
      case "tool_call_end": {
        out.push(ev("response.function_call_arguments.done", { output_index: nextOutputIndex - 1, arguments: lastCallArgs }));
        const doneItem = { type: "function_call", id: `fc_${ctx.id}_${event.index}`, call_id: lastCallId, name: lastCallName, arguments: lastCallArgs, status: "completed" };
        completedOutput.push(doneItem);
        out.push(
          ev("response.output_item.done", {
            output_index: nextOutputIndex - 1,
            item: doneItem,
          }),
        );
        break;
      }
      case "usage":
        pendingUsage = event.usage;
        pendingCost = event.cost;
        break;
      case "stop": {
        if (ended) break;
        ended = true;
        closeTextItem();
        closeReasoningItem();
        const usage: Record<string, unknown> = pendingUsage
          ? {
              input_tokens: pendingUsage.inputTokens,
              output_tokens: pendingUsage.outputTokens,
              total_tokens: pendingUsage.inputTokens + pendingUsage.outputTokens,
              input_tokens_details: { cached_tokens: pendingUsage.cachedTokens ?? 0 },
              output_tokens_details: { reasoning_tokens: pendingUsage.reasoningTokens ?? 0 },
            }
          : { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
        if (pendingCost !== undefined) usage["cost"] = pendingCost;
        const status = event.stopReason === "max_tokens" ? "incomplete" : event.stopReason === "error" ? "failed" : "completed";
        const response = {
          ...baseResponse(status),
          output: completedOutput,
          usage,
          incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null,
        };
        out.push(ev("response.completed", { response }));
        break;
      }
      case "error": {
        if (ended) break;
        ended = true;
        out.push(ev("error", { code: event.error.type, message: event.error.message, param: null }));
        break;
      }
    }
    return out;
  };
}
