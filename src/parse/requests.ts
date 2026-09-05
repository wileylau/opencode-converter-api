/**
 * Inbound request parsers: public API format → CanonicalRequest.
 * Three public formats: OpenAI Chat Completions, Anthropic Messages, OpenAI Responses.
 * (Gemini-style `?key=` auth is supported on all endpoints; there is no public
 * Gemini-format input — gemini models are reached through the three formats.)
 */

import type {
  CanonicalRequest,
  CanonicalMessage,
  ContentBlock,
  ReasoningEffort,
  ResponseFormat,
  ToolDefinition,
} from "../canonical";
import { mimeFromUrl, parseDataUrl } from "../util";

// ---------- OpenAI Chat Completions ----------

interface ChatContentPart {
  type: string;
  text?: string;
  image_url?: { url?: string } | string;
  input_audio?: { data?: string; format?: string };
  [k: string]: unknown;
}

function chatPartsToBlocks(parts: ChatContentPart[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        blocks.push({ type: "text", text: String(part.text ?? "") });
        break;
      case "image_url": {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (typeof url !== "string" || !url) break;
        const dataUrl = parseDataUrl(url);
        if (dataUrl) {
          blocks.push({ type: "image", mimeType: dataUrl.mimeType || "image/png", data: dataUrl.base64, isUrl: false });
        } else {
          blocks.push({ type: "image", mimeType: mimeFromUrl(url, "image/jpeg"), data: url, isUrl: true });
        }
        break;
      }
      case "input_audio": {
        const audio = part.input_audio;
        if (!audio?.data) break;
        const mime = audio.format === "wav" ? "audio/wav" : audio.format === "mp4" ? "audio/mp4" : "audio/mpeg";
        blocks.push({ type: "audio", mimeType: mime, data: audio.data, isUrl: false });
        break;
      }
      case "video_url": {
        // OpenRouter-style extension
        const url = typeof part.video_url === "string" ? part.video_url : (part.video_url as { url?: string })?.url;
        if (typeof url !== "string" || !url) break;
        const dataUrl = parseDataUrl(url);
        if (dataUrl) blocks.push({ type: "video", mimeType: dataUrl.mimeType || "video/mp4", data: dataUrl.base64, isUrl: false });
        else blocks.push({ type: "video", mimeType: mimeFromUrl(url, "video/mp4"), data: url, isUrl: true });
        break;
      }
      case "file": {
        const file = part.file as { file_data?: string; filename?: string } | undefined;
        if (!file?.file_data) break;
        const dataUrl = parseDataUrl(file.file_data);
        if (dataUrl) {
          const isImage = dataUrl.mimeType.startsWith("image/");
          blocks.push(
            isImage
              ? { type: "image", mimeType: dataUrl.mimeType, data: dataUrl.base64, isUrl: false }
              : { type: "document", mimeType: dataUrl.mimeType || "application/pdf", data: dataUrl.base64, isUrl: false, filename: file.filename },
          );
        } else {
          blocks.push({ type: "document", mimeType: mimeFromUrl(file.file_data, "application/pdf"), data: file.file_data, isUrl: true, filename: file.filename });
        }
        break;
      }
      default:
        if (typeof part.text === "string") blocks.push({ type: "text", text: part.text });
        break;
    }
  }
  return blocks;
}

function chatMessageToCanonical(msg: Record<string, unknown>): CanonicalMessage[] {
  const role = msg.role as string;
  const name = typeof msg.name === "string" ? msg.name : undefined;
  const out: CanonicalMessage[] = [];

  if (role === "tool") {
    out.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: String(msg.tool_call_id ?? ""),
          content: typeof msg.content === "string" ? msg.content : (msg.content as unknown),
          isError: false,
        },
      ],
    });
    return out;
  }

  const content = msg.content;
  let blocks: ContentBlock[] = [];
  if (typeof content === "string") {
    blocks = [{ type: "text", text: content }];
  } else if (Array.isArray(content)) {
    blocks = chatPartsToBlocks(content as ChatContentPart[]);
  }

  if (role === "assistant") {
    const toolCalls = msg.tool_calls as { id?: string; function?: { name?: string; arguments?: string } }[] | undefined;
    if (toolCalls?.length) {
      for (const tc of toolCalls) {
        let input: unknown = {};
        const args = tc.function?.arguments;
        if (typeof args === "string" && args) {
          try {
            input = JSON.parse(args);
          } catch {
            input = { _raw: args };
          }
        }
        blocks.push({ type: "tool_use", id: tc.id ?? `call_${Math.random().toString(36).slice(2)}`, name: tc.function?.name ?? "", input });
      }
    }
  }
  const canonicalRole = role === "system" || role === "developer" ? "system" : role === "assistant" ? "assistant" : "user";
  out.push({ role: canonicalRole, content: blocks, ...(name ? { name } : {}) });
  return out;
}

export function parseChatCompletionsRequest(body: Record<string, unknown>): CanonicalRequest {
  const rawMessages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const messages: CanonicalMessage[] = [];
  for (const m of rawMessages) messages.push(...chatMessageToCanonical(m));

  const tools: ToolDefinition[] = [];
  const rawTools = body.tools as { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }[] | undefined;
  if (Array.isArray(rawTools)) {
    for (const t of rawTools) {
      const fn = t.function ?? (t as { name?: string; description?: string; parameters?: unknown });
      if (!fn?.name) continue;
      tools.push({ name: fn.name, description: fn.description, parameters: fn.parameters });
    }
  }

  let toolChoice: CanonicalRequest["toolChoice"] = "auto";
  const tc = body.tool_choice;
  if (tc === "none" || tc === "required" || tc === "auto") toolChoice = tc;
  else if (tc && typeof tc === "object") {
    const name = (tc as { function?: { name?: string } }).function?.name ?? (tc as { name?: string }).name;
    if (name) toolChoice = { name };
  }

  const stop = body.stop;
  const stopSequences = typeof stop === "string" ? [stop] : Array.isArray(stop) ? stop.map(String) : [];

  let responseFormat: ResponseFormat | undefined;
  const rf = body.response_format as { type?: string; json_schema?: { schema?: unknown; name?: string } } | undefined;
  if (rf?.type === "json_schema" && rf.json_schema?.schema) {
    responseFormat = { type: "json_schema", jsonSchema: rf.json_schema.schema, schemaName: rf.json_schema.name };
  } else if (rf?.type === "json_object") {
    responseFormat = { type: "json_object" };
  }

  const reasoningEffort = normalizeEffort(body.reasoning_effort ?? (body.reasoning as { effort?: string } | undefined)?.effort);

  return {
    model: String(body.model ?? ""),
    messages,
    tools,
    toolChoice,
    maxTokens: pickNumber(body.max_completion_tokens) ?? pickNumber(body.max_tokens) ?? undefined,
    temperature: pickNumber(body.temperature) ?? undefined,
    topP: pickNumber(body.top_p) ?? undefined,
    stopSequences,
    stream: Boolean(body.stream),
    parallelToolCalls: typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : undefined,
    reasoningEffort,
    responseFormat,
    metadata: undefined,
    extras: {},
  };
}

function normalizeEffort(v: unknown): ReasoningEffort | undefined {
  if (typeof v !== "string") return undefined;
  switch (v) {
    case "none":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return v;
    default:
      return undefined;
  }
}

function pickNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// ---------- Anthropic Messages ----------

interface AnthropicContent {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  source?: { type?: string; media_type?: string; data?: string; url?: string };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  title?: string;
}

export function parseAnthropicRequest(body: Record<string, unknown>): CanonicalRequest {
  const rawMessages = Array.isArray(body.messages) ? (body.messages as Record<string, unknown>[]) : [];
  const systemRaw = body.system;
  const messages: CanonicalMessage[] = [];
  if (typeof systemRaw === "string" && systemRaw) {
    messages.push({ role: "system", content: systemRaw });
  } else if (Array.isArray(systemRaw)) {
    const text = (systemRaw as AnthropicContent[])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("\n\n");
    if (text) messages.push({ role: "system", content: text });
  }

  for (const m of rawMessages) {
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = m.content;
    let blocks: ContentBlock[] = [];
    if (typeof content === "string") {
      blocks = [{ type: "text", text: content }];
    } else if (Array.isArray(content)) {
      for (const b of content as AnthropicContent[]) {
        switch (b.type) {
          case "text":
            blocks.push({ type: "text", text: b.text ?? "" });
            break;
          case "image": {
            const src = b.source ?? {};
            if (src.type === "url" && src.url) {
              blocks.push({ type: "image", mimeType: mimeFromUrl(src.url, "image/jpeg"), data: src.url, isUrl: true });
            } else if (src.data) {
              blocks.push({ type: "image", mimeType: src.media_type ?? "image/png", data: src.data, isUrl: false });
            }
            break;
          }
          case "document": {
            const src = b.source ?? {};
            if (src.type === "url" && src.url) {
              blocks.push({ type: "document", mimeType: "application/pdf", data: src.url, isUrl: true, filename: b.title });
            } else if (src.data) {
              blocks.push({ type: "document", mimeType: src.media_type ?? "application/pdf", data: src.data, isUrl: false, filename: b.title });
            }
            break;
          }
          case "tool_use":
            blocks.push({ type: "tool_use", id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} });
            break;
          case "tool_result":
            blocks.push({
              type: "tool_result",
              toolUseId: b.tool_use_id ?? "",
              content: b.content ?? "",
              isError: Boolean(b.is_error),
            });
            break;
          case "thinking":
            // preserve signed thinking so claude multi-turn agentic loops validate
            blocks.push({ type: "reasoning", text: b.thinking ?? "", opaque: b.signature ?? "" });
            break;
          case "redacted_thinking":
            // opaque upstream payload cannot be safely replayed cross-family; skip
            break;
          case "audio":
          case "video": {
            const src = b.source ?? {};
            if (src.data) blocks.push({ type: b.type === "audio" ? "audio" : "video", mimeType: src.media_type ?? (b.type === "audio" ? "audio/mpeg" : "video/mp4"), data: src.data, isUrl: false });
            break;
          }
          default:
            if (typeof b.text === "string") blocks.push({ type: "text", text: b.text });
            break;
        }
      }
    }
    messages.push({ role, content: blocks });
  }

  const tools: ToolDefinition[] = [];
  const rawTools = body.tools as { name?: string; description?: string; input_schema?: unknown }[] | undefined;
  if (Array.isArray(rawTools)) {
    for (const t of rawTools) {
      if (!t.name) continue;
      tools.push({ name: t.name, description: t.description, parameters: t.input_schema });
    }
  }

  let toolChoice: CanonicalRequest["toolChoice"] = "auto";
  const tc = body.tool_choice as { type?: string; name?: string } | undefined;
  if (tc?.type === "auto") toolChoice = "auto";
  else if (tc?.type === "any") toolChoice = "required";
  else if (tc?.type === "none") toolChoice = "none";
  else if (tc?.type === "tool" && tc.name) toolChoice = { name: tc.name };

  const thinking = body.thinking as { type?: string; budget_tokens?: number } | undefined;
  let reasoningEffort: ReasoningEffort | undefined;
  if (thinking?.type === "enabled") {
    const budget = thinking.budget_tokens ?? 8192;
    reasoningEffort = budget >= 16384 ? "high" : budget >= 4096 ? "medium" : "low";
  }

  const stopSequences = Array.isArray(body.stop_sequences) ? (body.stop_sequences as unknown[]).map(String) : [];
  return {
    model: String(body.model ?? ""),
    messages,
    tools,
    toolChoice,
    maxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    topP: typeof body.top_p === "number" ? body.top_p : undefined,
    stopSequences,
    stream: Boolean(body.stream),
    parallelToolCalls: undefined,
    reasoningEffort,
    responseFormat: undefined,
    metadata: (body.metadata as Record<string, unknown> | undefined) ?? undefined,
    extras: {},
  };
}

// ---------- OpenAI Responses ----------

interface ResponseItem {
  type?: string;
  role?: string;
  content?: unknown;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
  summary?: unknown;
  encrypted_content?: string;
  [k: string]: unknown;
}

interface ResponsesContentPart {
  type: string;
  text?: string;
  image_url?: string;
  input_audio?: { data?: string; format?: string };
  file_data?: string;
  filename?: string;
  [k: string]: unknown;
}

export function parseResponsesRequest(body: Record<string, unknown>): CanonicalRequest {
  const messages: CanonicalMessage[] = [];

  const instructions = body.instructions;
  if (typeof instructions === "string" && instructions) {
    messages.push({ role: "system", content: instructions });
  }

  const rawInput = body.input;
  if (typeof rawInput === "string") {
    messages.push({ role: "user", content: rawInput });
  } else if (Array.isArray(rawInput)) {
    for (const item of rawInput as ResponseItem[]) {
      const type = item.type ?? (item.role ? "message" : "");
      if (type === "message" && item.role) {
        const blocks = responsesPartsToBlocks(item.content);
        messages.push({ role: item.role === "assistant" ? "assistant" : item.role === "system" ? "system" : "user", content: blocks });
      } else if (type === "function_call") {
        let input: unknown = {};
        try {
          input = JSON.parse(String(item.arguments ?? "{}"));
        } catch {
          input = { _raw: item.arguments };
        }
        messages.push({ role: "assistant", content: [{ type: "tool_use", id: item.call_id ?? item.id ?? "", name: item.name ?? "", input }] });
      } else if (type === "function_call_output") {
        messages.push({ role: "user", content: [{ type: "tool_result", toolUseId: item.call_id ?? "", content: item.output ?? "", isError: false }] });
      } else if (type === "reasoning") {
        // encrypted reasoning replay: keep opaque for responses target; ignore for others
        const summary = item.summary;
        const text = Array.isArray(summary)
          ? (summary as { text?: string; type?: string }[]).map((s) => s.text ?? "").join("")
          : "";
        messages.push({
          role: "assistant",
          content: text ? [{ type: "reasoning", text }] : [],
        });
      } else if (typeof item.role === "string") {
        const blocks = responsesPartsToBlocks(item.content);
        messages.push({ role: item.role === "assistant" ? "assistant" : "user", content: blocks });
      }
    }
  }

  const tools: ToolDefinition[] = [];
  const rawTools = body.tools as { type?: string; name?: string; description?: string; parameters?: unknown }[] | undefined;
  if (Array.isArray(rawTools)) {
    for (const t of rawTools) {
      if (t.type === "function" && t.name) {
        tools.push({ name: t.name, description: t.description, parameters: t.parameters });
      }
      // built-in tools (web_search, etc.) are dropped: zen models may not support them
    }
  }

  let toolChoice: CanonicalRequest["toolChoice"] = "auto";
  const tc = body.tool_choice;
  if (tc === "none" || tc === "required" || tc === "auto") toolChoice = tc;
  else if (tc && typeof tc === "object") {
    const name = (tc as { name?: string }).name;
    if (name) toolChoice = { name };
  }

  const reasoning = body.reasoning as { effort?: string } | undefined;
  const reasoningEffort = normalizeEffort(reasoning?.effort);

  let responseFormat: ResponseFormat | undefined;
  const text = body.text as { format?: { type?: string; name?: string; schema?: unknown } } | undefined;
  if (text?.format?.type === "json_schema" && text.format.schema) {
    responseFormat = { type: "json_schema", jsonSchema: text.format.schema, schemaName: text.format.name };
  } else if (text?.format?.type === "json_object") {
    responseFormat = { type: "json_object" };
  }

  const stopSequences: string[] = [];
  return {
    model: String(body.model ?? ""),
    messages,
    tools,
    toolChoice,
    maxTokens: typeof body.max_output_tokens === "number" ? body.max_output_tokens : undefined,
    temperature: typeof body.temperature === "number" ? body.temperature : undefined,
    topP: typeof body.top_p === "number" ? body.top_p : undefined,
    stopSequences,
    stream: Boolean(body.stream),
    parallelToolCalls: typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : undefined,
    reasoningEffort,
    responseFormat,
    metadata: (body.metadata as Record<string, unknown> | undefined) ?? undefined,
    extras: {},
  };
}

function responsesPartsToBlocks(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const part of content as ResponsesContentPart[]) {
    switch (part.type) {
      case "input_text":
      case "output_text":
      case "text":
        blocks.push({ type: "text", text: String(part.text ?? "") });
        break;
      case "input_image": {
        const url = part.image_url;
        if (typeof url !== "string" || !url) break;
        const dataUrl = parseDataUrl(url);
        if (dataUrl) blocks.push({ type: "image", mimeType: dataUrl.mimeType || "image/png", data: dataUrl.base64, isUrl: false });
        else blocks.push({ type: "image", mimeType: mimeFromUrl(url, "image/jpeg"), data: url, isUrl: true });
        break;
      }
      case "input_audio": {
        const audio = part.input_audio;
        if (!audio?.data) break;
        const mime = audio.format === "wav" ? "audio/wav" : audio.format === "mp4" ? "audio/mp4" : "audio/mpeg";
        blocks.push({ type: "audio", mimeType: mime, data: audio.data, isUrl: false });
        break;
      }
      case "input_file": {
        const fd = part.file_data;
        if (typeof fd !== "string" || !fd) break;
        const dataUrl = parseDataUrl(fd);
        if (dataUrl) {
          const isImage = dataUrl.mimeType.startsWith("image/");
          const isVideo = dataUrl.mimeType.startsWith("video/");
          blocks.push(
            isImage
              ? { type: "image", mimeType: dataUrl.mimeType, data: dataUrl.base64, isUrl: false }
              : isVideo
                ? { type: "video", mimeType: dataUrl.mimeType || "video/mp4", data: dataUrl.base64, isUrl: false }
                : { type: "document", mimeType: dataUrl.mimeType || "application/pdf", data: dataUrl.base64, isUrl: false, filename: part.filename },
          );
        } else {
          blocks.push({ type: "document", mimeType: mimeFromUrl(fd, "application/pdf"), data: fd, isUrl: true, filename: part.filename });
        }
        break;
      }
      default:
        if (typeof part.text === "string") blocks.push({ type: "text", text: part.text });
        break;
    }
  }
  return blocks;
}
