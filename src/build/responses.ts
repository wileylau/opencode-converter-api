/**
 * Upstream JSON responses → the three public non-streaming formats.
 * Parses any of the four native zen response shapes into CanonicalResponse,
 * then renders it as OpenAI Chat Completions / Anthropic Messages / OpenAI Responses.
 */

import type { CanonicalResponse, CanonicalToolCall } from "../canonical";
import type { ZenEndpoint } from "../zen";
import { ZenError } from "../zen";
import { streamToText, randomId } from "../util";

// ---------- upstream → canonical ----------

interface UpstreamChat {
  id?: string;
  model?: string;
  created?: number;
  choices?: {
    message?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] | null;
    } | null;
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    cost?: number | string;
  } | null;
  cost?: number | string;
  error?: { type?: string; message?: string } | string;
  type?: string;
  message?: string;
}

interface UpstreamAnthropic {
  id?: string;
  model?: string;
  content?: { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  type?: string;
  error?: { type?: string; message?: string };
}

interface UpstreamResponses {
  id?: string;
  model?: string;
  created_at?: number;
  status?: string;
  output?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: { type?: string; text?: string }[];
    summary?: { type?: string; text?: string }[];
    encrypted_content?: string;
  }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
  incomplete_details?: { reason?: string } | null;
  error?: { code?: string; message?: string } | null;
  cost?: number | string;
  message?: string;
}

interface UpstreamGemini {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean; functionCall?: { name?: string; args?: object } }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

export function upstreamToCanonical(endpoint: ZenEndpoint, raw: string, fallbackModel: string): CanonicalResponse {
  const created = Math.floor(Date.now() / 1000);

  if (endpoint === "chat") {
    const data = JSON.parse(raw) as UpstreamChat;
    if (data.error) {
      const err = typeof data.error === "string" ? { message: data.error, type: data.type } : data.error;
      throw new ZenError(502, err?.type ?? "upstream_error", err?.message ?? "upstream error");
    }
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const output: CanonicalResponse["output"] = [];
    const reasoning = msg?.reasoning_content ?? msg?.reasoning;
    if (reasoning) output.push({ type: "reasoning", text: reasoning });
    if (msg?.content) output.push({ type: "text", text: msg.content });
    const tools: CanonicalToolCall[] = (msg?.tool_calls ?? []).map((tc, i) => ({
      type: "tool_call",
      id: tc.id ?? `call_${i}`,
      name: tc.function?.name ?? "",
      argumentsJson: tc.function?.arguments ?? "{}",
    }));
    output.push(...tools);
    const finish = choice?.finish_reason;
    return {
      id: data.id ?? randomId("chatcmpl"),
      model: data.model ?? fallbackModel,
      output,
      stopReason: finish === "length" ? "max_tokens" : finish === "tool_calls" || finish === "function_call" ? "tool_use" : finish === "content_filter" ? "stop_sequence" : "end",
      usage: data.usage
        ? {
            inputTokens: data.usage.prompt_tokens ?? 0,
            outputTokens: data.usage.completion_tokens ?? 0,
            cachedTokens: data.usage.prompt_tokens_details?.cached_tokens,
            reasoningTokens: data.usage.completion_tokens_details?.reasoning_tokens,
          }
        : undefined,
      cost: data.usage?.cost ?? data.cost,
      created: data.created ?? created,
    };
  }

  if (endpoint === "messages") {
    const data = JSON.parse(raw) as UpstreamAnthropic;
    if (data.error) throw new ZenError(502, data.error.type ?? "upstream_error", data.error.message ?? "upstream error");
    const output: CanonicalResponse["output"] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text" && block.text) output.push({ type: "text", text: block.text });
      else if (block.type === "thinking" && block.thinking) output.push({ type: "reasoning", text: block.thinking });
      else if (block.type === "tool_use" && block.name)
        output.push({ type: "tool_call", id: block.id ?? "", name: block.name, argumentsJson: JSON.stringify(block.input ?? {}) });
    }
    return {
      id: data.id ?? randomId("msg"),
      model: data.model ?? fallbackModel,
      output,
      stopReason: data.stop_reason === "max_tokens" ? "max_tokens" : data.stop_reason === "tool_use" ? "tool_use" : data.stop_reason === "stop_sequence" ? "stop_sequence" : "end",
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens ?? 0,
            outputTokens: data.usage.output_tokens ?? 0,
            cachedTokens: data.usage.cache_read_input_tokens,
          }
        : undefined,
      created,
    };
  }

  if (endpoint === "responses") {
    const data = JSON.parse(raw) as UpstreamResponses;
    if (data.error) throw new ZenError(502, data.error.code ?? "upstream_error", data.error.message ?? "upstream error");
    const output: CanonicalResponse["output"] = [];
    for (const item of data.output ?? []) {
      if (item.type === "message") {
        const text = (item.content ?? [])
          .filter((c) => c.type === "output_text")
          .map((c) => c.text ?? "")
          .join("");
        if (text) output.push({ type: "text", text });
      } else if (item.type === "reasoning") {
        const summary = (item.summary ?? []).map((s) => s.text ?? "").join("");
        output.push({ type: "reasoning", text: summary, opaque: item.encrypted_content });
      } else if (item.type === "function_call") {
        output.push({ type: "tool_call", id: item.call_id ?? item.id ?? "", name: item.name ?? "", argumentsJson: item.arguments ?? "{}" });
      }
    }
    return {
      id: data.id ?? randomId("resp"),
      model: data.model ?? fallbackModel,
      output,
      stopReason:
        output.some((o) => o.type === "tool_call")
          ? "tool_use"
          : data.status === "incomplete"
            ? data.incomplete_details?.reason === "max_output_tokens"
              ? "max_tokens"
              : "stop_sequence"
            : "end",
      usage: data.usage
        ? {
            inputTokens: data.usage.input_tokens ?? 0,
            outputTokens: data.usage.output_tokens ?? 0,
            cachedTokens: data.usage.input_tokens_details?.cached_tokens,
            reasoningTokens: data.usage.output_tokens_details?.reasoning_tokens,
          }
        : undefined,
      cost: data.cost,
      created: data.created_at ?? created,
    };
  }

  // gemini
  const data = JSON.parse(raw) as UpstreamGemini;
  const output: CanonicalResponse["output"] = [];
  let stopReason: CanonicalResponse["stopReason"] = "end";
  for (const cand of data.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      if (part.functionCall) {
        output.push({ type: "tool_call", id: randomId("call"), name: part.functionCall.name ?? "", argumentsJson: JSON.stringify(part.functionCall.args ?? {}) });
      } else if (typeof part.text === "string" && part.text) {
        if (part.thought) output.push({ type: "reasoning", text: part.text });
        else output.push({ type: "text", text: part.text });
      }
    }
    if (cand.finishReason === "MAX_TOKENS") stopReason = "max_tokens";
    else if (cand.finishReason === "STOP" && output.some((o) => o.type === "tool_call")) stopReason = "tool_use";
    else if (["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(cand.finishReason ?? "")) stopReason = "stop_sequence";
  }
  const u = data.usageMetadata;
  return {
    id: randomId("gem"),
    model: fallbackModel,
    output,
    stopReason,
    usage: u
      ? {
          inputTokens: u.promptTokenCount ?? 0,
          outputTokens: u.candidatesTokenCount ?? 0,
          cachedTokens: u.cachedContentTokenCount,
          reasoningTokens: u.thoughtsTokenCount,
        }
      : undefined,
    created,
  };
}

export async function readUpstreamJson(endpoint: ZenEndpoint, response: Response, fallbackModel: string): Promise<CanonicalResponse> {
  const text = await streamToText(response.body!);
  if (!response.ok) throw zenErrorFromText(response.status, text);
  return upstreamToCanonical(endpoint, text, fallbackModel);
}

export function zenErrorFromText(status: number, text: string, retryAfterHeader?: string | null): ZenError {
  let type = "upstream_error";
  let message = text.slice(0, 600) || `upstream returned ${status}`;
  try {
    const data = JSON.parse(text) as { error?: { type?: string; message?: string } | string; type?: string; message?: string };
    if (typeof data.error === "string") {
      message = data.error;
      if (data.type) type = data.type;
    } else if (data.error && typeof data.error === "object") {
      type = data.error.type ?? type;
      message = data.error.message ?? message;
    } else if (data.message) {
      message = data.message;
      if (data.type) type = data.type;
    }
  } catch {
    /* non-json body */
  }
  const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  return new ZenError(status, type, message, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined);
}

// ---------- canonical → public formats ----------

export function canonicalToChatCompletion(c: CanonicalResponse): Record<string, unknown> {
  const text = c.output.filter((o) => o.type === "text").map((o) => (o as { text: string }).text).join("");
  const reasoning = c.output.filter((o) => o.type === "reasoning").map((o) => (o as { text: string }).text).join("");
  const toolCalls = c.output.filter((o): o is CanonicalToolCall => o.type === "tool_call");
  const message: Record<string, unknown> = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (reasoning) message["reasoning_content"] = reasoning;
  if (toolCalls.length) {
    message["tool_calls"] = toolCalls.map((t) => ({
      id: t.id,
      type: "function",
      function: { name: t.name, arguments: t.argumentsJson || "{}" },
    }));
  }
  const usage = c.usage
    ? {
        prompt_tokens: c.usage.inputTokens,
        completion_tokens: c.usage.outputTokens,
        total_tokens: c.usage.inputTokens + c.usage.outputTokens,
        prompt_tokens_details: { cached_tokens: c.usage.cachedTokens ?? 0 },
        completion_tokens_details: { reasoning_tokens: c.usage.reasoningTokens ?? 0 },
      }
    : undefined;
  const body: Record<string, unknown> = {
    id: c.id,
    object: "chat.completion",
    created: c.created,
    model: c.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason:
          c.stopReason === "max_tokens"
            ? "length"
            : c.stopReason === "tool_use"
              ? "tool_calls"
              : c.stopReason === "stop_sequence" || c.stopReason === "error"
                ? "content_filter"
                : "stop",
      },
    ],
  };
  if (usage) body["usage"] = usage;
  if (c.cost !== undefined) body["cost"] = c.cost;
  return body;
}

export function canonicalToAnthropicMessage(c: CanonicalResponse): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  for (const o of c.output) {
    if (o.type === "text" && o.text) content.push({ type: "text", text: o.text });
    else if (o.type === "reasoning" && o.text) content.push({ type: "thinking", thinking: o.text, signature: "" });
    else if (o.type === "tool_call") {
      let input: unknown = {};
      try {
        input = JSON.parse(o.argumentsJson || "{}");
      } catch {
        input = { _raw: o.argumentsJson };
      }
      content.push({ type: "tool_use", id: o.id, name: o.name, input });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });
  const usage: Record<string, unknown> = {
    input_tokens: c.usage?.inputTokens ?? 0,
    output_tokens: c.usage?.outputTokens ?? 0,
  };
  if (c.usage?.cachedTokens !== undefined) usage["cache_read_input_tokens"] = c.usage.cachedTokens;
  const message: Record<string, unknown> = {
    id: c.id,
    type: "message",
    role: "assistant",
    model: c.model,
    content,
    stop_reason:
      c.stopReason === "max_tokens"
        ? "max_tokens"
        : c.stopReason === "tool_use"
          ? "tool_use"
          : c.stopReason === "stop_sequence" || c.stopReason === "error"
            ? "stop_sequence"
            : "end_turn",
    stop_sequence: null,
    usage,
  };
  if (c.cost !== undefined) message["cost"] = c.cost;
  return message;
}

export function canonicalToResponsesObject(c: CanonicalResponse): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  for (const o of c.output) {
    if (o.type === "text" && o.text) {
      output.push({
        type: "message",
        id: `msg_${c.id.replace(/^resp_/, "")}`,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: o.text, annotations: [] }],
      });
    } else if (o.type === "reasoning" && o.text) {
      const item: Record<string, unknown> = { type: "reasoning", id: `rs_${c.id.replace(/^resp_/, "")}`, summary: [{ type: "summary_text", text: o.text }] };
      if (o.opaque) item["encrypted_content"] = o.opaque;
      output.push(item);
    } else if (o.type === "tool_call") {
      output.push({ type: "function_call", id: `fc_${o.id}`, call_id: o.id, name: o.name, arguments: o.argumentsJson || "{}", status: "completed" });
    }
  }
  const usage: Record<string, unknown> = c.usage
    ? {
        input_tokens: c.usage.inputTokens,
        output_tokens: c.usage.outputTokens,
        total_tokens: c.usage.inputTokens + c.usage.outputTokens,
        input_tokens_details: { cached_tokens: c.usage.cachedTokens ?? 0 },
        output_tokens_details: { reasoning_tokens: c.usage.reasoningTokens ?? 0 },
      }
    : { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  if (c.cost !== undefined) usage["cost"] = c.cost;
  const status =
    c.stopReason === "error" ? "failed" : c.stopReason === "max_tokens" || c.stopReason === "stop_sequence" ? "incomplete" : "completed";
  return {
    id: c.id,
    object: "response",
    created_at: c.created,
    status,
    model: c.model,
    output,
    parallel_tool_calls: true,
    error: null,
    incomplete_details:
      status === "incomplete" ? { reason: c.stopReason === "max_tokens" ? "max_output_tokens" : "content_filter" } : null,
    ...(status === "failed" ? { error: { code: "upstream_error", message: "the upstream model reported an error" } } : {}),
    usage,
    tool_choice: "auto",
    tools: [],
  };
}

export type PublicFormat = "chat" | "messages" | "responses";

export function canonicalToPublic(format: PublicFormat, c: CanonicalResponse): Record<string, unknown> {
  switch (format) {
    case "chat":
      return canonicalToChatCompletion(c);
    case "messages":
      return canonicalToAnthropicMessage(c);
    case "responses":
      return canonicalToResponsesObject(c);
  }
}
