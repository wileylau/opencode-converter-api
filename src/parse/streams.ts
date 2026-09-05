/**
 * Upstream SSE → CanonicalEvent parsers for the four native zen stream formats.
 * All parsers consume a full SSE byte stream and yield canonical events.
 */

import type { CanonicalEvent, CanonicalUsage } from "../canonical";

export interface SseMessage {
  event?: string;
  data: string;
}

/** Split an SSE byte stream into `{event, data}` messages, ignoring comments/keep-alives. */
export async function* readSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  let event: string | undefined;
  let dataLines: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line === "") {
          // dispatch
          if (dataLines.length) {
            yield { event, data: dataLines.join("\n") };
          }
          event = undefined;
          dataLines = [];
        } else if (line.startsWith(":")) {
          // comment / keep-alive
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
      }
    }
    if (dataLines.length) {
      yield { event, data: dataLines.join("\n") };
    }
  } finally {
    // Terminate early (client disconnected / consumer cancelled): stop the upstream body too.
    try {
      await reader.cancel();
    } catch {
      /* noop */
    }
  }
}

// ---------- OpenAI chat.completion.chunk ----------

interface ChatChunk {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    delta?: {
      role?: string | null;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: { index?: number; id?: string | null; function?: { name?: string | null; arguments?: string | null } }[] | null;
    } | null;
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
    cost?: number | string;
  } | null;
  cost?: number | string;
  error?: { type?: string; message?: string };
}

function mapFinishReason(finish: string | null | undefined): { stop?: Extract<CanonicalEvent, { type: "stop" }> } {
  if (!finish) return {};
  switch (finish) {
    case "stop":
      return { stop: { type: "stop", stopReason: "end" } };
    case "length":
      return { stop: { type: "stop", stopReason: "max_tokens" } };
    case "tool_calls":
    case "function_call":
      return { stop: { type: "stop", stopReason: "tool_use" } };
    case "content_filter":
      return { stop: { type: "stop", stopReason: "stop_sequence" } };
    default:
      return { stop: { type: "stop", stopReason: "end" } };
  }
}

export async function* parseChatChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<CanonicalEvent> {
  let started = false;
  let toolIndex = -1;
  const seenToolIds = new Set<number>();
  // OpenAI sends the usage chunk AFTER the finish_reason chunk; hold the stop
  // until the generator ends so consumers always see usage before stop.
  let pendingFinish: Extract<CanonicalEvent, { type: "stop" }> | null = null;

  for await (const msg of readSse(stream)) {
    if (!msg.data || msg.data === "[DONE]") continue;
    let chunk: ChatChunk;
    try {
      chunk = JSON.parse(msg.data) as ChatChunk;
    } catch {
      continue;
    }
    if (chunk.error) {
      yield { type: "error", error: { type: chunk.error.type ?? "upstream_error", message: chunk.error.message ?? "upstream error" } };
      return;
    }
    if (!started && chunk.id) {
      started = true;
      yield { type: "start", id: chunk.id, model: chunk.model ?? "" };
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      if (!delta) continue;
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) yield { type: "reasoning_delta", delta: reasoning };
      if (typeof delta.content === "string" && delta.content) yield { type: "text_delta", delta: delta.content };
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          if (!seenToolIds.has(idx)) {
            seenToolIds.add(idx);
            if (toolIndex >= 0) {
              yield { type: "tool_call_end", index: toolIndex };
            }
            toolIndex = idx;
            yield { type: "tool_call_start", index: idx, id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? "" };
          }
          const argsDelta = tc.function?.arguments;
          if (typeof argsDelta === "string" && argsDelta) yield { type: "tool_call_delta", index: idx, argsDelta };
        }
      }
      const finish = mapFinishReason(choice.finish_reason);
      if (finish.stop) {
        if (toolIndex >= 0) {
          yield { type: "tool_call_end", index: toolIndex };
          toolIndex = -1;
        }
        // hold the stop: OpenAI sends the usage chunk after finish_reason, and
        // consumers need usage before the stream closes
        pendingFinish = finish.stop;
      }
    }
    if (chunk.usage) {
      yield {
        type: "usage",
        usage: {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens,
          reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
        },
        cost: chunk.usage.cost ?? chunk.cost,
      };
    }
  }
  if (pendingFinish) {
    yield pendingFinish;
  }
}

// ---------- Anthropic messages SSE ----------

interface AnthropicSse {
  type?: string;
  message?: { id?: string; model?: string; usage?: { input_tokens?: number; cache_read_input_tokens?: number } };
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  error?: { type?: string; message?: string };
}

export async function* parseAnthropicEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<CanonicalEvent> {
  let started = false;
  let anthropicUsage: CanonicalUsage | undefined;
  const openTools = new Map<number, boolean>();
  for await (const msg of readSse(stream)) {
    if (!msg.data) continue;
    let ev: AnthropicSse;
    try {
      ev = JSON.parse(msg.data) as AnthropicSse;
    } catch {
      continue;
    }
    const type = ev.type ?? msg.event;
    switch (type) {
      case "message_start": {
        started = true;
        yield { type: "start", id: ev.message?.id ?? "", model: ev.message?.model ?? "" };
        const u = ev.message?.usage;
        if (u) {
          anthropicUsage = { inputTokens: u.input_tokens ?? 0, outputTokens: 0, cachedTokens: u.cache_read_input_tokens };
          yield { type: "usage", usage: anthropicUsage };
        }
        break;
      }
      case "content_block_start": {
        const block = ev.content_block ?? {};
        if (block.type === "tool_use") {
          openTools.set(ev.index ?? 0, true);
          yield { type: "tool_call_start", index: ev.index ?? 0, id: block.id ?? "", name: block.name ?? "" };
        }
        break;
      }
      case "content_block_delta": {
        const d = ev.delta ?? {};
        if (d.type === "text_delta" && d.text) yield { type: "text_delta", delta: d.text };
        else if (d.type === "thinking_delta" && d.thinking) yield { type: "reasoning_delta", delta: d.thinking };
        else if (d.type === "input_json_delta" && d.partial_json) yield { type: "tool_call_delta", index: ev.index ?? 0, argsDelta: d.partial_json };
        break;
      }
      case "content_block_stop": {
        if (openTools.get(ev.index ?? 0)) {
          openTools.set(ev.index ?? 0, false);
          yield { type: "tool_call_end", index: ev.index ?? 0 };
        }
        break;
      }
      case "message_delta": {
        const d = ev.delta ?? {};
        // Anthropic's message_delta usage carries only output_tokens (plus optional
        // cache fields) — merge it into the message_start usage instead of replacing.
        if (ev.usage) {
          // message_delta may repeat input_tokens; take the max instead of summing,
          // and accumulate output_tokens which arrive incrementally
          const merged = {
            inputTokens: Math.max(anthropicUsage?.inputTokens ?? 0, ev.usage.input_tokens ?? 0),
            outputTokens: Math.max(anthropicUsage?.outputTokens ?? 0, ev.usage.output_tokens ?? 0),
            cachedTokens: ev.usage.cache_read_input_tokens ?? anthropicUsage?.cachedTokens,
          };
          anthropicUsage = merged;
          yield { type: "usage", usage: merged };
        }
        if (d.stop_reason) {
          yield mapAnthropicStop(d.stop_reason);
        }
        break;
      }
      case "error":
        yield { type: "error", error: { type: ev.error?.type ?? "upstream_error", message: ev.error?.message ?? "upstream error" } };
        return;
      case "message_stop":
        return;
      case "ping":
      case "content_block_start_text":
      default:
        break;
    }
  }
  if (!started) {
    // stream ended without message_start — likely an error already emitted
  }
}

function mapAnthropicStop(reason: string): Extract<CanonicalEvent, { type: "stop" }> {
  let stopReason: CanonicalEvent extends never ? never : Extract<CanonicalEvent, { type: "stop" }>["stopReason"];
  switch (reason) {
    case "max_tokens":
      stopReason = "max_tokens";
      break;
    case "tool_use":
      stopReason = "tool_use";
      break;
    case "stop_sequence":
      stopReason = "stop_sequence";
      break;
    case "refusal":
    case "pause_turn":
      stopReason = "end";
      break;
    default:
      stopReason = "end";
  }
  return { type: "stop", stopReason };
}

// ---------- OpenAI Responses SSE ----------

interface ResponsesSse {
  type?: string;
  response?: {
    id?: string;
    model?: string;
    status?: string;
    usage?: ResponsesUsage;
    error?: { code?: string; message?: string } | null;
    output?: { type?: string; content?: { type?: string; text?: string }[]; summary?: { type?: string; text?: string }[] }[];
  };
  item?: { type?: string; id?: string; call_id?: string; name?: string };
  output_index?: number;
  delta?: string;
  text?: string;
  usage?: ResponsesUsage;
  sequence_number?: number;
}
interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
  cost?: number | string;
}

export async function* parseResponsesEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<CanonicalEvent> {
  let started = false;
  const openCalls = new Map<number, boolean>();
  const textDeltaSeen = new Set<number>();
  const reasoningDeltaSeen = new Set<number>();
  let sawAnyText = false;
  let sawAnyReasoning = false;
  for await (const msg of readSse(stream)) {
    if (!msg.data) continue;
    let ev: ResponsesSse;
    try {
      ev = JSON.parse(msg.data) as ResponsesSse;
    } catch {
      continue;
    }
    const type = ev.type ?? msg.event;
    switch (type) {
      case "response.created":
      case "response.in_progress": {
        if (!started && ev.response?.id) {
          started = true;
          yield { type: "start", id: ev.response.id, model: ev.response.model ?? "" };
        }
        break;
      }
      case "response.output_item.added": {
        const item = ev.item ?? {};
        if (item.type === "function_call") {
          const idx = ev.output_index ?? 0;
          openCalls.set(idx, true);
          yield { type: "tool_call_start", index: idx, id: item.call_id ?? item.id ?? "", name: item.name ?? "" };
        }
        break;
      }
      case "response.output_text.delta": {
        if (ev.delta) {
          textDeltaSeen.add(ev.output_index ?? 0);
          sawAnyText = true;
          yield { type: "text_delta", delta: ev.delta };
        }
        break;
      }
      case "response.output_text.done": {
        // some upstreams deliver the whole text only in done (no deltas)
        const idx = ev.output_index ?? 0;
        if (!textDeltaSeen.has(idx) && ev.text) {
          textDeltaSeen.add(idx);
          sawAnyText = true;
          yield { type: "text_delta", delta: ev.text };
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (ev.delta) {
          reasoningDeltaSeen.add(ev.output_index ?? 0);
          sawAnyReasoning = true;
          yield { type: "reasoning_delta", delta: ev.delta };
        }
        break;
      }
      case "response.reasoning_summary_text.done":
      case "response.reasoning_text.done": {
        // reasoning delivered only in done form (muse does this)
        const idx = ev.output_index ?? 0;
        if (!reasoningDeltaSeen.has(idx) && ev.text) {
          reasoningDeltaSeen.add(idx);
          sawAnyReasoning = true;
          yield { type: "reasoning_delta", delta: ev.text };
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        if (ev.delta) yield { type: "tool_call_delta", index: ev.output_index ?? 0, argsDelta: ev.delta };
        break;
      }
      case "response.function_call_arguments.done": {
        const idx = ev.output_index ?? 0;
        if (openCalls.get(idx)) {
          openCalls.set(idx, false);
          yield { type: "tool_call_end", index: idx };
        }
        break;
      }
      case "response.output_item.done": {
        const item = ev.item ?? {};
        if (item.type === "function_call") {
          const idx = ev.output_index ?? 0;
          if (openCalls.get(idx)) {
            openCalls.set(idx, false);
            yield { type: "tool_call_end", index: idx };
          }
        }
        break;
      }
      case "response.failed":
      case "response.incomplete": {
        const err = ev.response?.error;
        // error first: consumers terminate the stream on `stop`
        if (err?.message) yield { type: "error", error: { type: err.code ?? "upstream_error", message: err.message } };
        yield {
          type: "stop",
          stopReason: ev.response?.status === "incomplete" ? "max_tokens" : "error",
        };
        break;
      }
      case "response.completed": {
        // Final safety net: if the upstream never streamed visible text but the
        // completed response object carries message text (or reasoning summary
        // text), replay it — muse occasionally emits text only here.
        const completedOutput = ev.response?.output;
        if (Array.isArray(completedOutput)) {
          if (!sawAnyReasoning) {
            const rs = responsesOutputReasoning(completedOutput);
            if (rs) {
              sawAnyReasoning = true;
              yield { type: "reasoning_delta", delta: rs };
            }
          }
          if (!sawAnyText) {
            const txt = responsesOutputText(completedOutput);
            if (txt) {
              sawAnyText = true;
              yield { type: "text_delta", delta: txt };
            }
          }
        }
        if (ev.response?.usage) {
          yield usageEvent(ev.response.usage, (ev.response as { cost?: number | string }).cost);
        }
        yield { type: "stop", stopReason: "end" };
        return;
      }
      case "error": {
        const err = (ev as unknown as { error?: { code?: string; message?: string } }).error;
        yield { type: "error", error: { type: err?.code ?? "upstream_error", message: err?.message ?? "upstream error" } };
        return;
      }
      default:
        break;
    }
  }
}

/** Extract concatenated message text from a completed response's output items. */
function responsesOutputText(
  output: NonNullable<NonNullable<ResponsesSse["response"]>["output"]>,
): string {
  let text = "";
  for (const item of output as { type?: string; content?: { type?: string; text?: string }[] }[]) {
    if (item?.type !== "message") continue;
    for (const part of item.content ?? []) {
      if ((part?.type === "output_text" || part?.type === "text") && part.text) text += part.text;
    }
  }
  return text;
}

/** Extract concatenated reasoning summary text from a completed response's output items. */
function responsesOutputReasoning(output: unknown[]): string {
  let text = "";
  for (const item of output as { type?: string; summary?: { type?: string; text?: string }[] }[]) {
    if (item?.type !== "reasoning") continue;
    for (const part of item.summary ?? []) {
      if (part?.text) text += part.text;
    }
  }
  return text;
}

function usageEvent(u: ResponsesUsage, cost?: number | string): Extract<CanonicalEvent, { type: "usage" }> {
  return {
    type: "usage",
    usage: {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cachedTokens: u.input_tokens_details?.cached_tokens,
      reasoningTokens: u.output_tokens_details?.reasoning_tokens,
    },
    cost,
  };
}

// ---------- Gemini SSE ----------

interface GeminiChunk {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean; functionCall?: { name?: string; args?: object } }[] };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
    cachedContentTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

export async function* parseGeminiSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<CanonicalEvent> {
  let started = false;
  let toolIdx = 0;
  let pendingStop: Extract<CanonicalEvent, { type: "stop" }> | null = null;
  for await (const msg of readSse(stream)) {
    if (!msg.data) continue;
    let chunk: GeminiChunk;
    try {
      chunk = JSON.parse(msg.data) as GeminiChunk;
    } catch {
      continue;
    }
    if (!started) {
      started = true;
      yield { type: "start", id: "", model: "" };
    }
    for (const cand of chunk.candidates ?? []) {
      for (const part of cand.content?.parts ?? []) {
        if (part.functionCall) {
          yield { type: "tool_call_start", index: toolIdx, id: `call_${toolIdx}`, name: part.functionCall.name ?? "" };
          yield {
            type: "tool_call_delta",
            index: toolIdx,
            argsDelta: JSON.stringify(part.functionCall.args ?? {}),
          };
          yield { type: "tool_call_end", index: toolIdx };
          toolIdx += 1;
        } else if (typeof part.text === "string" && part.text) {
          if (part.thought) yield { type: "reasoning_delta", delta: part.text };
          else yield { type: "text_delta", delta: part.text };
        }
      }
      if (cand.finishReason) {
        // usageMetadata arrives after candidates; hold stop so usage is emitted first
        pendingStop = { type: "stop", stopReason: geminiStopReason(cand.finishReason) };
      }
    }
    const u = chunk.usageMetadata;
    if (u) {
      const usage: CanonicalUsage = {
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: u.candidatesTokenCount ?? 0,
        cachedTokens: u.cachedContentTokenCount,
        reasoningTokens: u.thoughtsTokenCount,
      };
      yield { type: "usage", usage };
    }
    if (pendingStop) {
      yield pendingStop;
      pendingStop = null;
    }
  }
}

// Fix 17: treat safety/refusal-class finish reasons as stop_sequence, not a clean end
function geminiStopReason(reason: string): Extract<CanonicalEvent, { type: "stop" }>["stopReason"] {
  if (reason === "MAX_TOKENS") return "max_tokens";
  if (reason === "SAFETY" || reason === "RECITATION" || reason === "PROHIBITED_CONTENT" || reason === "BLOCKLIST" || reason === "SPII") return "stop_sequence";
  return "end";
}

// ---------- dispatch ----------

export function streamParserFor(endpoint: "chat" | "messages" | "responses" | "gemini") {
  switch (endpoint) {
    case "chat":
      return parseChatChunks;
    case "messages":
      return parseAnthropicEvents;
    case "responses":
      return parseResponsesEvents;
    case "gemini":
      return parseGeminiSse;
  }
}
