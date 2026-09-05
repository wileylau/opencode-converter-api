/**
 * Canonical request → native zen request bodies for the four zen endpoints.
 */

import type { CanonicalRequest, CanonicalMessage, ContentBlock, ToolDefinition } from "../canonical";
import type { ZenEndpoint } from "../zen";
import { ToolNameMapper } from "../tools";
import { effortBudgetTokens, effortForOpenAi } from "../reasoning";

const A = (m: ToolNameMapper | undefined, name: string): string => (m ? m.alias(name) : name);

// ---------- helpers ----------

function isTextBlock(b: ContentBlock): b is Extract<ContentBlock, { type: "text" }> {
  return b.type === "text";
}

export function b64OrUrl(block: Extract<ContentBlock, { type: "image" | "audio" | "video" | "document" }>): string {
  return block.isUrl ? block.data : `data:${block.mimeType};base64,${block.data}`;
}

function effortValue(effort: CanonicalRequest["reasoningEffort"], endpoint: ZenEndpoint): unknown {
  if (!effort || effort === "none") return effort === "none" && endpoint !== "messages" ? "none" : undefined;
  switch (endpoint) {
    case "chat":
    case "responses":
      return effortForOpenAi(effort);
    case "messages":
      return effortBudgetTokens(effort);
    case "gemini":
      // gemini uses generationConfig.thinkingConfig.thinkingBudget; handled in buildGeminiBody
      return undefined;
  }
}

function splitSystem(messages: CanonicalMessage[]): { system: string; rest: CanonicalMessage[] } {
  const parts: string[] = [];
  const rest: CanonicalMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (typeof m.content === "string") parts.push(m.content);
      else for (const b of m.content) if (isTextBlock(b)) parts.push(b.text);
    } else {
      rest.push(m);
    }
  }
  return { system: parts.join("\n\n"), rest };
}

// ---------- OpenAI Chat Completions body ----------

export function buildChatCompletionsBody(req: CanonicalRequest, stream: boolean, tm?: ToolNameMapper): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  const { system, rest } = splitSystem(req.messages);
  if (system) messages.push({ role: "system", content: system });

  for (const m of rest) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: m.content, ...(m.name ? { name: m.name } : {}) });
      continue;
    }
    // assistant tool_use blocks become tool_calls; tool_result blocks become tool role messages
    const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    const toolResults = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
    const other = m.content.filter((b) => b.type !== "tool_use" && b.type !== "tool_result");

    if (m.role === "assistant") {
      const text = other.filter(isTextBlock).map((b) => b.text).join("");
      const reasoning = other.filter((b): b is Extract<ContentBlock, { type: "reasoning" }> => b.type === "reasoning");
      void reasoning;
      // an assistant turn with neither text nor tool calls is rejected by
      // openai-shaped endpoints — skip it entirely
      if (text || toolUses.length) {
        messages.push({
          role: "assistant",
          ...(text ? { content: text } : { content: null }),
          ...(toolUses.length
            ? {
                tool_calls: toolUses.map((t) => ({
                  id: t.id,
                  type: "function",
                  function: { name: A(tm, t.name), arguments: safeJsonString(t.input) },
                })),
              }
            : {}),
        });
      }
    } else {
      // user message with tool results → one "tool" message per result, then remaining content
      for (const tr of toolResults) {
        messages.push({
          role: "tool",
          tool_call_id: tr.toolUseId,
          content: toolResultText(tr),
        });
      }
      if (other.length) {
        messages.push({ role: "user", content: contentPartsOpenAI(other) });
      }
    }
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream,
  };
  if (stream) body["stream_options"] = { include_usage: true };
  if (req.maxTokens !== undefined) body["max_tokens"] = req.maxTokens;
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.topP !== undefined) body["top_p"] = req.topP;
  if (req.stopSequences.length) body["stop"] = req.stopSequences;
  if (req.tools.length) {
    body["tools"] = req.tools.map((t) => ({
      type: "function",
      function: { name: A(tm, t.name), description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } },
    }));
    body["tool_choice"] =
      req.toolChoice === "auto" || req.toolChoice === "none" || req.toolChoice === "required"
        ? req.toolChoice
        : { type: "function", function: { name: A(tm, req.toolChoice.name) } };
    if (req.parallelToolCalls !== undefined && req.toolChoice !== "none") body["parallel_tool_calls"] = req.parallelToolCalls;
  }
  const effort = effortValue(req.reasoningEffort, "chat");
  if (effort !== undefined) body["reasoning_effort"] = effort;
  if (req.responseFormat) {
    body["response_format"] =
      req.responseFormat.type === "json_object"
        ? { type: "json_object" }
        : {
            type: "json_schema",
            json_schema: {
              name: req.responseFormat.schemaName ?? "response",
              schema: req.responseFormat.jsonSchema ?? {},
              strict: false,
            },
          };
  }
  return { ...req.extras, ...body };
}

function safeJsonString(input: unknown): string {
  if (input === undefined || input === null) return "{}";
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input);
  } catch {
    return "{}";
  }
}

export function toolResultText(tr: Extract<ContentBlock, { type: "tool_result" }>): string {
  if (typeof tr.content === "string") return tr.content;
  if (Array.isArray(tr.content)) {
    const parts: string[] = [];
    for (const b of tr.content as ContentBlock[]) {
      if (b.type === "text") parts.push(b.text);
      else if (b.type === "image") parts.push("[image attached]");
      else parts.push(`[${b.type}]`);
    }
    return parts.join("\n");
  }
  return safeJsonString(tr.content);
}

function contentPartsOpenAI(blocks: ContentBlock[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        parts.push({ type: "text", text: b.text });
        break;
      case "image":
        parts.push({ type: "image_url", image_url: { url: b64OrUrl(b) } });
        break;
      case "audio":
        // OpenAI chat audio format (base64 only); URLs → best-effort reference
        if (!b.isUrl) {
          const format = b.mimeType.includes("wav") ? "wav" : b.mimeType.includes("mp4") ? "mp4" : "mp3";
          parts.push({ type: "input_audio", input_audio: { data: b.data, format } });
        } else {
          parts.push({ type: "text", text: `[audio: ${b.data}]` });
        }
        break;
      case "video":
        if (!b.isUrl) {
          parts.push({ type: "image_url", image_url: { url: `data:${b.mimeType};base64,${b.data}` } });
        } else {
          parts.push({ type: "image_url", image_url: { url: b.data } });
        }
        break;
      case "document":
        parts.push({ type: "text", text: `[document ${b.filename ?? ""} attached — not supported by this model]` });
        break;
      case "reasoning":
        break; // drop prior reasoning on replay
      default:
        break;
    }
  }
  return parts;
}

// ---------- Anthropic Messages body ----------

export function buildAnthropicBody(req: CanonicalRequest, stream: boolean, tm?: ToolNameMapper): Record<string, unknown> {
  const { system, rest } = splitSystem(req.messages);
  const messages: Record<string, unknown>[] = [];
  for (const m of rest) {
    if (typeof m.content === "string") {
      messages.push({ role: m.role, content: [{ type: "text", text: m.content }] });
      continue;
    }
    const blocks: Record<string, unknown>[] = [];
    for (const b of m.content) {
      switch (b.type) {
        case "text":
          blocks.push({ type: "text", text: b.text });
          break;
        case "image":
          if (b.isUrl) {
            blocks.push({ type: "image", source: { type: "url", url: b.data } });
          } else {
            blocks.push({ type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } });
          }
          break;
        case "document":
          if (b.isUrl) {
            blocks.push({ type: "document", source: { type: "url", url: b.data }, title: b.filename ?? "document" });
          } else {
            blocks.push({
              type: "document",
              source: { type: "base64", media_type: b.mimeType === "application/pdf" ? b.mimeType : "application/pdf", data: b.data },
              ...(b.filename ? { title: b.filename } : {}),
            });
          }
          break;
        case "audio":
        case "video":
          blocks.push({ type: "text", text: `[${b.type} attached${b.isUrl ? `: ${b.data}` : ""} — not supported by this model]` });
          break;
        case "tool_use":
          blocks.push({ type: "tool_use", id: b.id, name: A(tm, b.name), input: b.input ?? {} });
          break;
        case "tool_result":
          blocks.push({
            type: "tool_result",
            tool_use_id: b.toolUseId,
            content: typeof b.content === "string" ? [{ type: "text", text: b.content }] : anthropicToolResultContent(b.content),
            ...(b.isError ? { is_error: true } : {}),
          });
          break;
        case "reasoning":
          // replay signed thinking blocks (required shape for claude agentic loops
          // with thinking enabled); unsigned ones are dropped to avoid 400s
          if (req.reasoningEffort && b.text) {
            blocks.push({ type: "thinking", thinking: b.text, signature: b.opaque ?? "" });
          }
          break;
      }
    }
    if (blocks.length) messages.push({ role: m.role, content: blocks });
  }

  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    max_tokens: req.maxTokens ?? 4096,
    stream,
  };
  if (system) body["system"] = system;
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.topP !== undefined) body["top_p"] = req.topP;
  if (req.stopSequences.length) body["stop_sequences"] = req.stopSequences;
  if (req.tools.length) {
    body["tools"] = req.tools.map(
      (t: ToolDefinition) => ({
        name: A(tm, t.name),
        description: t.description ?? "",
        input_schema: t.parameters ?? { type: "object", properties: {} },
      }),
    );
    // anthropic rejects FORCED tool choice combined with thinking; auto/none are fine
    const forced = req.toolChoice === "required" || typeof req.toolChoice === "object";
    if (!(req.reasoningEffort && forced)) {
      body["tool_choice"] =
        req.toolChoice === "auto"
          ? { type: "auto" }
          : req.toolChoice === "none"
            ? { type: "none" }
            : req.toolChoice === "required"
              ? { type: "any" }
              : { type: "tool", name: A(tm, req.toolChoice.name) };
    }
  }
  if (req.reasoningEffort && req.reasoningEffort !== "none") {
    // anthropic requires budget_tokens < max_tokens, so clamp (and skip thinking
    // entirely when the caller's budget leaves no room for it)
    const maxTokens = (body["max_tokens"] as number) ?? 4096;
    const want = effortBudgetTokens(req.reasoningEffort);
    const budget = Math.min(want, Math.max(0, maxTokens - 1024));
    if (budget >= 1024) {
      body["thinking"] = { type: "enabled", budget_tokens: budget };
      // anthropic requires temperature=1 and forbids top_p with thinking
      body["temperature"] = 1;
      delete body["top_p"];
    }
  }
  return body;
}

function anthropicToolResultContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    const out: Record<string, unknown>[] = [];
    for (const b of content as ContentBlock[]) {
      if (b.type === "text") out.push({ type: "text", text: b.text });
      else if (b.type === "image" && !b.isUrl)
        out.push({ type: "image", source: { type: "base64", media_type: b.mimeType, data: b.data } });
      else if (b.type === "image") out.push({ type: "image", source: { type: "url", url: b.data } });
    }
    if (out.length) return out;
  }
  return [{ type: "text", text: safeJsonString(content) }];
}

// ---------- OpenAI Responses body ----------

export function buildResponsesBody(req: CanonicalRequest, stream: boolean, tm?: ToolNameMapper): Record<string, unknown> {
  const { system, rest } = splitSystem(req.messages);
  const input: Record<string, unknown>[] = [];
  if (system) input.push({ role: "system", content: system });

  for (const m of rest) {
    if (typeof m.content === "string") {
      input.push({ role: m.role, content: m.content });
      continue;
    }
    const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    const toolResults = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
    const other = m.content.filter((b) => b.type !== "tool_use" && b.type !== "tool_result");

    if (m.role === "assistant") {
      // function calls
      for (const t of toolUses) {
        input.push({ type: "function_call", call_id: t.id, name: A(tm, t.name), arguments: safeJsonString(t.input) });
      }
      const text = other.filter(isTextBlock).map((b) => b.text).join("");
      if (text) {
        input.push({ role: "assistant", content: text });
      } else if (other.some((b) => b.type !== "reasoning")) {
        input.push({ role: "assistant", content: responsesContentParts(other) });
      }
    } else {
      for (const tr of toolResults) {
        input.push({ type: "function_call_output", call_id: tr.toolUseId, output: toolResultText(tr) });
      }
      if (other.length) {
        input.push({ role: "user", content: responsesContentParts(other) });
      }
    }
  }

  const body: Record<string, unknown> = {
    model: req.model,
    input,
    stream,
  };
  if (req.maxTokens !== undefined) body["max_output_tokens"] = req.maxTokens;
  if (req.temperature !== undefined) body["temperature"] = req.temperature;
  if (req.topP !== undefined) body["top_p"] = req.topP;
  if (req.tools.length) {
    body["tools"] = req.tools.map((t) => ({
      type: "function",
      name: A(tm, t.name),
      description: t.description ?? "",
      parameters: t.parameters ?? { type: "object", properties: {} },
    }));
    body["tool_choice"] =
      req.toolChoice === "auto" || req.toolChoice === "none" || req.toolChoice === "required"
        ? req.toolChoice
        : { type: "function", name: A(tm, req.toolChoice.name) };
    if (req.parallelToolCalls !== undefined) body["parallel_tool_calls"] = req.parallelToolCalls;
  }
  const effort = effortValue(req.reasoningEffort, "responses");
  if (effort !== undefined) body["reasoning"] = { effort };
  if (req.responseFormat) {
    body["text"] = { format: { type: "json_object" } };
    if (req.responseFormat.type === "json_schema" && req.responseFormat.jsonSchema) {
      body["text"] = {
        format: {
          type: "json_schema",
          name: req.responseFormat.schemaName ?? "response",
          schema: req.responseFormat.jsonSchema,
        },
      };
    }
  }
  return body;
}

function responsesContentParts(blocks: ContentBlock[]): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        parts.push({ type: "input_text", text: b.text });
        break;
      case "image":
        parts.push({ type: "input_image", image_url: b64OrUrl(b) });
        break;
      case "audio":
        if (!b.isUrl) {
          const format = b.mimeType.includes("wav") ? "wav" : b.mimeType.includes("mp4") ? "mp4" : "mp3";
          parts.push({ type: "input_audio", input_audio: { data: b.data, format } });
        } else {
          parts.push({ type: "input_text", text: `[audio: ${b.data}]` });
        }
        break;
      case "video":
        parts.push({
          type: "input_file",
          filename: "input.mp4",
          file_data: b.isUrl ? b.data : `data:${b.mimeType};base64,${b.data}`,
        });
        break;
      case "document":
        parts.push({
          type: "input_file",
          ...(b.filename ? { filename: b.filename } : {}),
          file_data: b.isUrl ? b.data : `data:${b.mimeType};base64,${b.data}`,
        });
        break;
      case "reasoning":
        break;
      default:
        break;
    }
  }
  return parts;
}

// ---------- Gemini body ----------

export function buildGeminiBody(req: CanonicalRequest, stream: boolean, tm?: ToolNameMapper): Record<string, unknown> {
  const { system, rest } = splitSystem(req.messages);
  const contents: Record<string, unknown>[] = [];
  // Gemini's functionResponse requires the function NAME, so keep a map of
  // call id → tool name collected from prior assistant tool_use blocks.
  const toolNamesById = new Map<string, string>();
  for (const m of rest) {
    if (typeof m.content !== "string") {
      for (const b of m.content) {
        if (b.type === "tool_use" && b.id) toolNamesById.set(b.id, b.name);
      }
    }
  }
  const gA = (name: string): string => A(tm, name);
  for (const m of rest) {
    const parts: Record<string, unknown>[] = [];
    if (typeof m.content === "string") {
      parts.push({ text: m.content });
    } else {
      const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
      const toolResults = m.content.filter((b): b is Extract<ContentBlock, { type: "tool_result" }> => b.type === "tool_result");
      const other = m.content.filter((b) => b.type !== "tool_use" && b.type !== "tool_result");
      for (const b of other) {
        switch (b.type) {
          case "text":
            parts.push({ text: b.text });
            break;
          case "image":
            parts.push(geminiInlineData(b.mimeType, b.data, b.isUrl));
            break;
          case "audio":
            parts.push(geminiInlineData(b.mimeType, b.data, b.isUrl));
            break;
          case "video":
            parts.push(geminiInlineData(b.mimeType, b.data, b.isUrl));
            break;
          case "document":
            parts.push(geminiInlineData("application/pdf", b.data, b.isUrl));
            break;
          default:
            break;
        }
      }
      for (const t of toolUses) {
        parts.push({ functionCall: { name: gA(t.name), args: (t.input ?? {}) as object } });
      }
      for (const tr of toolResults) {
        // only alias a real tool name; aliasing a bare call id would pollute the
        // reverse map and could rewrite a later tool name to an id
        const known = toolNamesById.get(tr.toolUseId);
        const fnName = known ? gA(known) : tr.toolUseId;
        parts.push({ functionResponse: { name: fnName, response: { result: toolResultText(tr) } } });
      }
    }
    if (parts.length) {
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
    }
  }

  const body: Record<string, unknown> = { contents };
  if (system) body["systemInstruction"] = { parts: [{ text: system }] };
  const generationConfig: Record<string, unknown> = {};
  if (req.maxTokens !== undefined) generationConfig["maxOutputTokens"] = req.maxTokens;
  if (req.temperature !== undefined) generationConfig["temperature"] = req.temperature;
  if (req.topP !== undefined) generationConfig["topP"] = req.topP;
  if (req.stopSequences.length) generationConfig["stopSequences"] = req.stopSequences;
  if (req.responseFormat?.jsonSchema) {
    generationConfig["responseMimeType"] = "application/json";
    generationConfig["responseSchema"] = sanitizeGeminiSchema(req.responseFormat.jsonSchema);
  } else if (req.responseFormat?.type === "json_object") {
    generationConfig["responseMimeType"] = "application/json";
  }
  if (Object.keys(generationConfig).length) body["generationConfig"] = generationConfig;
  if (req.tools.length) {
    body["tools"] = [{ functionDeclarations: req.tools.map((t) => ({ name: gA(t.name), description: t.description ?? "", parameters: t.parameters ?? { type: "object", properties: {} } })) }];
    const mode =
      req.toolChoice === "none" ? "NONE" : req.toolChoice === "required" || typeof req.toolChoice === "object" ? "ANY" : "AUTO";
    body["toolConfig"] = {
      functionCallingConfig: {
        mode,
        ...(typeof req.toolChoice === "object" ? { allowedFunctionNames: [gA(req.toolChoice.name)] } : {}),
      },
    };
  }
  if (req.reasoningEffort) {
    const generation = (body["generationConfig"] as Record<string, unknown> | undefined) ?? {};
    generation["thinkingConfig"] =
      req.reasoningEffort === "none"
        ? { thinkingBudget: 0 }
        : { thinkingBudget: effortBudgetTokens(req.reasoningEffort), includeThoughts: true };
    body["generationConfig"] = generation;
  }
  void stream;
  return body;
}

function geminiInlineData(mimeType: string, data: string, isUrl: boolean): Record<string, unknown> {
  if (isUrl) return { fileData: { mimeType, fileUri: data } };
  return { inlineData: { mimeType, data } };
}

/**
 * Gemini's responseSchema accepts only an OpenAPI-subset of JSON Schema.
 * Strip keywords it rejects and drop `additionalProperties` (boolean form 400s).
 */
function sanitizeGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeGeminiSchema);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (
      k === "$schema" ||
      k === "$id" ||
      k === "$defs" ||
      k === "definitions" ||
      k === "default" ||
      k === "examples" ||
      k === "additionalProperties" ||
      k === "patternProperties" ||
      k === "if" ||
      k === "then" ||
      k === "else" ||
      k === "allOf" ||
      k === "anyOf" ||
      k === "oneOf" ||
      k === "not"
    ) {
      continue;
    }
    if (k === "type" && Array.isArray(v)) {
      const first = v.find((t) => typeof t === "string") ?? "string";
      out[k] = first;
      continue;
    }
    out[k] = sanitizeGeminiSchema(v);
  }
  return out;
}

// ---------- dispatch ----------

export function buildZenRequestBody(
  endpoint: ZenEndpoint,
  req: CanonicalRequest,
  stream: boolean,
  tm?: ToolNameMapper,
): Record<string, unknown> {
  switch (endpoint) {
    case "chat":
      return buildChatCompletionsBody(req, stream, tm);
    case "messages":
      return buildAnthropicBody(req, stream, tm);
    case "responses":
      return buildResponsesBody(req, stream, tm);
    case "gemini":
      return buildGeminiBody(req, stream, tm);
  }
}
