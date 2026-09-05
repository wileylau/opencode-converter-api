/**
 * Canonical internal request/response model.
 *
 * Every inbound API format (OpenAI Chat Completions, Anthropic Messages,
 * OpenAI Responses, Gemini-style) is parsed into this shape, and every
 * outbound zen format is built from it. Streaming uses canonical events.
 */

// ---------- content blocks ----------

export type TextBlock = { type: "text"; text: string };
export type ImageBlock = { type: "image"; mimeType: string; data: string /* base64 or URL */; isUrl: boolean };
export type AudioBlock = { type: "audio"; mimeType: string; data: string; isUrl: boolean };
export type VideoBlock = { type: "video"; mimeType: string; data: string; isUrl: boolean };
export type DocumentBlock = { type: "document"; mimeType: string; data: string; isUrl: boolean; filename?: string };
/** A tool call the assistant produced. */
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown; // JSON object
};
/** The result of a tool call, fed back as a user/role message. */
export type ToolResultBlock = {
  type: "tool_result";
  toolUseId: string;
  content: unknown; // string | structured content array
  isError: boolean;
};
/** Prior-turn reasoning, replayed as context. `opaque` carries e.g. the anthropic signature. */
export type ReasoningBlock = { type: "reasoning"; text: string; opaque?: string };

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | AudioBlock
  | VideoBlock
  | DocumentBlock
  | ToolUseBlock
  | ToolResultBlock
  | ReasoningBlock;

// ---------- reasoning ----------

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

// ---------- messages ----------

export interface CanonicalMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentBlock[];
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the tool's parameters. */
  parameters?: unknown;
}

export interface ResponseFormat {
  type: "json_schema" | "json_object";
  jsonSchema?: unknown;
  schemaName?: string;
}

export interface CanonicalRequest {
  model: string;
  messages: CanonicalMessage[];
  tools: ToolDefinition[];
  toolChoice: "auto" | "none" | "required" | { name: string };
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences: string[];
  stream: boolean;
  parallelToolCalls?: boolean;
  reasoningEffort?: ReasoningEffort;
  responseFormat?: ResponseFormat;
  metadata?: Record<string, unknown>;
  /** Always empty: unmapped client params are deliberately NOT forwarded upstream
   *  (zen rejects unknown params like `logprobs` with 400 invalid_request_error). */
  extras: Record<string, unknown>;
}

// ---------- usage ----------

export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export function addUsage(a: CanonicalUsage | undefined, b: CanonicalUsage | undefined): CanonicalUsage | undefined {
  if (!a && !b) return undefined;
  return {
    inputTokens: (a?.inputTokens ?? 0) + (b?.inputTokens ?? 0),
    outputTokens: (a?.outputTokens ?? 0) + (b?.outputTokens ?? 0),
    reasoningTokens: a?.reasoningTokens ?? b?.reasoningTokens,
    cachedTokens: a?.cachedTokens ?? b?.cachedTokens,
  };
}

// ---------- non-streaming result ----------

export interface CanonicalText {
  type: "text";
  text: string;
  /** reasoning summary text associated with this output, if the model emitted any */
}
export interface CanonicalToolCall {
  type: "tool_call";
  id: string;
  name: string;
  argumentsJson: string;
}
export interface CanonicalReasoning {
  type: "reasoning";
  text: string;
  /** opaque upstream item (e.g. responses `encrypted_content`) to echo back on continuation */
  opaque?: string;
}

export type CanonicalOutput = CanonicalText | CanonicalToolCall | CanonicalReasoning;

export interface CanonicalResponse {
  id: string;
  model: string;
  output: CanonicalOutput[];
  stopReason: "end" | "max_tokens" | "stop_sequence" | "tool_use" | "error";
  usage?: CanonicalUsage;
  /** provider-reported cost, if any */
  cost?: number | string;
  created: number; // unix seconds
}

// ---------- streaming events ----------

export type CanonicalEvent =
  | { type: "start"; id: string; model: string }
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | {
      type: "tool_call_start";
      index: number;
      id: string;
      name: string;
    }
  | { type: "tool_call_delta"; index: number; argsDelta: string }
  | { type: "tool_call_end"; index: number }
  | { type: "usage"; usage: CanonicalUsage; cost?: number | string }
  | { type: "stop"; stopReason: CanonicalResponse["stopReason"] }
  | { type: "error"; error: { type: string; message: string } };

export function canonicalResponseFromEvents(events: CanonicalEvent[], id: string, model: string, created: number): CanonicalResponse {
  const output: CanonicalOutput[] = [];
  let text = "";
  let reasoning = "";
  const toolCalls: CanonicalToolCall[] = [];
  const toolArgs = new Map<number, { id: string; name: string; args: string }>();
  let stopReason: CanonicalResponse["stopReason"] = "end";
  let usage: CanonicalUsage | undefined;

  for (const ev of events) {
    switch (ev.type) {
      case "text_delta":
        text += ev.delta;
        break;
      case "reasoning_delta":
        reasoning += ev.delta;
        break;
      case "tool_call_start":
        toolArgs.set(ev.index, { id: ev.id, name: ev.name, args: "" });
        break;
      case "tool_call_delta": {
        const t = toolArgs.get(ev.index);
        if (t) t.args += ev.argsDelta;
        break;
      }
      case "tool_call_end": {
        const t = toolArgs.get(ev.index);
        if (t) {
          toolCalls.push({ type: "tool_call", id: t.id, name: t.name, argumentsJson: t.args });
          toolArgs.delete(ev.index);
        }
        break;
      }
      case "usage":
        usage = ev.usage;
        break;
      case "stop":
        stopReason = ev.stopReason;
        break;
      case "error":
        stopReason = "error";
        break;
      case "start":
        break;
    }
  }

  // a stream truncated mid-tool-call still yields the partial call rather than losing it
  for (const t of toolArgs.values()) {
    toolCalls.push({ type: "tool_call", id: t.id, name: t.name, argumentsJson: t.args });
  }

  if (reasoning) output.push({ type: "reasoning", text: reasoning });
  output.push({ type: "text", text });
  output.push(...toolCalls);

  return { id, model, output, stopReason, usage, created };
}
