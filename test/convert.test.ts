import { describe, expect, it } from "vitest";
import { parseChatCompletionsRequest, parseAnthropicRequest, parseResponsesRequest } from "../src/parse/requests";
import { buildZenRequestBody } from "../src/build/zen";
import { upstreamToCanonical } from "../src/build/responses";
import { canonicalToPublic } from "../src/build/responses";
import { parseChatChunks, parseAnthropicEvents, parseResponsesEvents } from "../src/parse/streams";
import { createChatEmitter, createAnthropicEmitter, createResponsesEmitter } from "../src/build/streams";
import type { CanonicalEvent } from "../src/canonical";


function streamFromText(text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe("chat completions parsing", () => {
  it("parses a basic request with system, user, tools", () => {
    const req = parseChatCompletionsRequest({
      model: "big-pickle",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hello" },
      ],
      tools: [{ type: "function", function: { name: "get_time", description: "gets time", parameters: { type: "object", properties: {} } } }],
      max_tokens: 100,
      temperature: 0.5,
    });
    expect(req.model).toBe("big-pickle");
    expect(req.messages).toHaveLength(2);
    expect(req.messages[0]!.role).toBe("system");
    expect(req.tools[0]!.name).toBe("get_time");
    expect(req.maxTokens).toBe(100);
    expect(req.stream).toBe(false);
  });

  it("parses multimodal content parts", () => {
    const req = parseChatCompletionsRequest({
      model: "muse-spark-1.3-contributor-free",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
            { type: "input_audio", input_audio: { data: "QURBUA", format: "wav" } },
          ],
        },
      ],
    });
    const content = req.messages[0]!.content as { type: string; data?: string; mimeType?: string }[];
    expect(content).toHaveLength(3);
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "QUJD", isUrl: false });
    expect(content[2]).toMatchObject({ type: "audio", mimeType: "audio/wav" });
  });

  it("parses assistant tool_calls and tool role replies", () => {
    const req = parseChatCompletionsRequest({
      model: "m",
      messages: [
        { role: "user", content: "what time" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_time", arguments: "{\"tz\":\"utc\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "12:00" },
      ],
    });
    expect(req.messages[1]!.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "tool_use", id: "call_1", name: "get_time" })]),
    );
    expect(req.messages[2]!.content).toEqual([
      expect.objectContaining({ type: "tool_result", toolUseId: "call_1", content: "12:00" }),
    ]);
  });
});

describe("build: canonical → zen bodies", () => {
  it("builds chat body with tools and system", () => {
    const req = parseChatCompletionsRequest({
      model: "big-pickle",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
      stream: true,
    });
    const body = buildZenRequestBody("chat", req, true);
    expect(body["stream"]).toBe(true);
    expect(body["stream_options"]).toEqual({ include_usage: true });
    expect((body["messages"] as unknown[]).length).toBe(2);
    expect(Array.isArray(body["tools"])).toBe(true);
  });

  it("builds anthropic body with system top-level and base64 image", () => {
    const req = parseAnthropicRequest({
      model: "claude-haiku-4-5",
      max_tokens: 50,
      system: "be nice",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          ],
        },
      ],
    });
    const body = buildZenRequestBody("messages", req, false);
    expect(body["system"]).toBe("be nice");
    expect(body["max_tokens"]).toBe(50);
    const messages = body["messages"] as { content: { type: string; source?: { data?: string } }[] }[];
    expect(messages[0]!.content[1]!.source!.data).toBe("QUJD");
  });

  it("builds responses body with input array and function tools", () => {
    const req = parseResponsesRequest({
      model: "gpt-5.6-luna",
      instructions: "inst",
      input: [{ role: "user", content: [{ type: "input_text", text: "yo" }] }],
      tools: [{ type: "function", name: "fn", parameters: { type: "object" } }],
      max_output_tokens: 77,
    });
    const body = buildZenRequestBody("responses", req, false);
    expect(body["max_output_tokens"]).toBe(77);
    expect(body["instructions"]).toBeUndefined(); // system folded into input
    expect((body["input"] as unknown[])[0]).toMatchObject({ role: "system", content: "inst" });
    expect((body["tools"] as { type: string }[])[0]!.type).toBe("function");
  });

  it("converts tool loops correctly for responses target", () => {
    const req = parseResponsesRequest({
      model: "gpt-5.6-luna",
      input: [
        { role: "user", content: "call fn" },
        { type: "function_call", call_id: "c1", name: "fn", arguments: "{\"a\":1}" },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ],
    });
    const body = buildZenRequestBody("responses", req, false);
    const input = body["input"] as { type?: string; role?: string; call_id?: string }[];
    expect(input[0]).toMatchObject({ role: "user" });
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "c1", name: "fn" });
    expect(input[2]).toMatchObject({ type: "function_call_output", call_id: "c1" });
  });
});

describe("upstream → canonical → public", () => {
  it("converts a chat.completion to all three public formats", () => {
    const upstream = JSON.stringify({
      id: "up1",
      model: "big-pickle",
      created: 123,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi there", reasoning_content: "thinking" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      cost: "0",
    });
    const c = upstreamToCanonical("chat", upstream, "big-pickle");
    expect(c.output).toEqual([
      { type: "reasoning", text: "thinking" },
      { type: "text", text: "hi there" },
    ]);
    expect(c.usage).toMatchObject({ inputTokens: 10, outputTokens: 5 });

    const chat = canonicalToPublic("chat", c) as { choices: { message: { content: string } }[] };
    expect(chat.choices[0]!.message.content).toBe("hi there");

    const anthropic = canonicalToPublic("messages", c) as { content: { type: string }[]; stop_reason: string };
    expect(anthropic.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(anthropic.stop_reason).toBe("end_turn");

    const responses = canonicalToPublic("responses", c) as { output: { type: string }[] };
    expect(responses.output.map((o) => o.type)).toEqual(["reasoning", "message"]);
  });

  it("converts an anthropic message with tool_use", () => {
    const upstream = JSON.stringify({
      id: "msg_1",
      model: "claude-haiku-4-5",
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Paris" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    const c = upstreamToCanonical("messages", upstream, "claude-haiku-4-5");
    expect(c.stopReason).toBe("tool_use");
    const chat = canonicalToPublic("chat", c) as { choices: { message: { tool_calls: { function: { name: string } }[] }; finish_reason: string }[] };
    expect(chat.choices[0]!.message.tool_calls[0]!.function.name).toBe("get_weather");
    expect(chat.choices[0]!.finish_reason).toBe("tool_calls");
  });

  it("converts a responses object with function_call", () => {
    const upstream = JSON.stringify({
      id: "resp_1",
      model: "gpt-5.6-luna",
      status: "completed",
      output: [
        { type: "function_call", call_id: "call_x", name: "fn", arguments: "{\"x\":2}" },
      ],
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
    });
    const c = upstreamToCanonical("responses", upstream, "gpt-5.6-luna");
    expect(c.output[0]).toMatchObject({ type: "tool_call", name: "fn" });
    const anthro = canonicalToPublic("messages", c) as { content: { type: string; input?: unknown }[]; stop_reason: string };
    expect(anthro.content[0]).toMatchObject({ type: "tool_use", input: { x: 2 } });
    expect(anthro.stop_reason).toBe("tool_use");
  });
});

describe("stream parsing", () => {
  it("parses chat chunks with reasoning, text, tool call, usage", async () => {
    const sseText =
      `data: {"id":"c1","model":"big-pickle","choices":[{"index":0,"delta":{"role":"assistant","content":null}}]}\n\n` +
      `data: {"id":"c1","choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}\n\n` +
      `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n` +
      `data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"fn","arguments":"{\\"a\\""}}]}}]}\n\n` +
      `data: {"id":"c1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}\n\n` +
      `data: {"id":"c1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n` +
      `data: {"id":"c1","choices":[],"usage":{"prompt_tokens":7,"completion_tokens":9}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(parseChatChunks(streamFromText(sseText)));
    const types = events.map((e) => e.type);
    expect(types).toContain("reasoning_delta");
    expect(types).toContain("text_delta");
    expect(types).toContain("tool_call_start");
    expect(events.find((e) => e.type === "stop")).toMatchObject({ stopReason: "tool_use" });
    const usage = events.find((e) => e.type === "usage") as { usage: { inputTokens: number } };
    expect(usage.usage.inputTokens).toBe(7);
  });

  it("parses anthropic SSE", async () => {
    const sseText =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"claude-haiku-4-5","usage":{"input_tokens":12}}}\n\n` +
      `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n` +
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const events = await collect(parseAnthropicEvents(streamFromText(sseText)));
    expect(events[0]).toMatchObject({ type: "start", id: "msg_x" });
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(events.find((e) => e.type === "stop")).toMatchObject({ stopReason: "end" });
  });

  it("parses responses SSE with function call", async () => {
    const sseText =
      `event: response.created\ndata: {"type":"response.created","response":{"id":"resp_9","model":"gpt-5.6-luna"}}\n\n` +
      `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"cy_1","name":"fn"}}\n\n` +
      `event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"q\\":1}"}\n\n` +
      `event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"cy_1","name":"fn"}}\n\n` +
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_9","usage":{"input_tokens":4,"output_tokens":6}}}\n\n`;
    const events = await collect(parseResponsesEvents(streamFromText(sseText)));
    expect(events[0]).toMatchObject({ type: "start", id: "resp_9" });
    expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
    const stop = events.find((e) => e.type === "stop");
    expect(stop).toBeDefined();
  });
});

describe("stream emitting", () => {
  it("emits anthropic events from canonical stream", () => {
    const emit = createAnthropicEmitter({ model: "claude-haiku-4-5", id: "msg_t1" });
    const chunks: Uint8Array[] = [];
    for (const ev of [
      { type: "start", id: "msg_t1", model: "claude-haiku-4-5" },
      { type: "text_delta", delta: "He" },
      { type: "text_delta", delta: "y" },
      { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } },
      { type: "stop", stopReason: "end" },
    ] as CanonicalEvent[]) {
      chunks.push(...emit(ev));
    }
    const text = chunks.map((c) => new TextDecoder().decode(c)).join("");
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain("\"text\":\"He\"");
    expect(text).toContain("\"input_tokens\":2");
    expect(text).toContain("event: message_stop");
  });

  it("emits chat chunks with [DONE]", () => {
    const emit = createChatEmitter({ model: "big-pickle", id: "cc_1" });
    const chunks: Uint8Array[] = [];
    for (const ev of [
      { type: "text_delta", delta: "abc" },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      { type: "stop", stopReason: "end" },
    ] as CanonicalEvent[]) {
      chunks.push(...emit(ev));
    }
    const text = chunks.map((c) => new TextDecoder().decode(c)).join("");
    expect(text).toContain("\"content\":\"abc\"");
    expect(text).toContain("\"prompt_tokens\":1");
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  });

  it("emits responses events with sequence numbers", () => {
    const emit = createResponsesEmitter({ model: "gpt-5.6-luna", id: "resp_t" });
    const chunks: Uint8Array[] = [];
    for (const ev of [
      { type: "text_delta", delta: "x" },
      { type: "stop", stopReason: "end" },
    ] as CanonicalEvent[]) {
      chunks.push(...emit(ev));
    }
    const text = chunks.map((c) => new TextDecoder().decode(c)).join("");
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("event: response.completed");
  });
});

describe("review-fix regressions", () => {
  it("chat parser emits usage BEFORE the stop event", async () => {
    const sseText =
      `data: {"id":"c1","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n` +
      `data: {"id":"c1","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n` +
      `data: [DONE]\n\n`;
    const events = await collect(parseChatChunks(streamFromText(sseText)));
    const stopIdx = events.findIndex((e) => e.type === "stop");
    const usageIdx = events.findIndex((e) => e.type === "usage");
    expect(stopIdx).toBeGreaterThan(-1);
    expect(usageIdx).toBeGreaterThan(-1);
    expect(usageIdx).toBeLessThan(stopIdx);
  });

  it("anthropic message_delta usage merges with message_start usage", async () => {
    const sseText =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":40}}}\n\n` +
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":9}}\n\n` +
      `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
    const events = await collect(parseAnthropicEvents(streamFromText(sseText)));
    const usages = events.filter((e) => e.type === "usage") as { usage: { inputTokens: number; outputTokens: number } }[];
    const finalUsage = usages[usages.length - 1]!.usage;
    expect(finalUsage.inputTokens).toBe(40);
    expect(finalUsage.outputTokens).toBe(9);
    // usage must precede stop
    const stopIdx = events.findIndex((e) => e.type === "stop");
    const lastUsageIdx = usages.length ? events.lastIndexOf(usages[usages.length - 1] as never) : -1;
    expect(lastUsageIdx).toBeLessThan(stopIdx);
  });

  it("gemini functionResponse uses the tool NAME resolved from prior tool_use", () => {
    const req = parseAnthropicRequest({
      model: "gemini-3-flash",
      max_tokens: 100,
      messages: [
        { role: "user", content: "weather?" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_xyz", name: "get_weather", input: { city: "Paris" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_xyz", content: "18C" }] },
      ],
    });
    const body = buildZenRequestBody("gemini", req, false) as {
      contents: { role: string; parts: { functionResponse?: { name: string } }[] }[];
    };
    const toolMsg = body.contents.find((c) => c.parts.some((p) => p.functionResponse));
    expect(toolMsg!.parts.find((p) => p.functionResponse)!.functionResponse!.name).toBe("get_weather");
  });

  it("responses emitter accumulates tool arguments and output in completed", () => {
    const emit = createResponsesEmitter({ model: "gpt-5.6-luna", id: "resp_acc" });
    const chunks: Uint8Array[] = [];
    for (const ev of [
      { type: "tool_call_start", index: 0, id: "call_a", name: "fn" },
      { type: "tool_call_delta", index: 0, argsDelta: "{\"x\":" },
      { type: "tool_call_delta", index: 0, argsDelta: "1}" },
      { type: "tool_call_end", index: 0 },
      { type: "stop", stopReason: "tool_use" },
    ] as CanonicalEvent[]) {
      chunks.push(...emit(ev));
    }
    const text = chunks.map((c) => new TextDecoder().decode(c)).join("");
    // arguments.done carries the full accumulated args
    expect(text).toContain('"arguments":"{\\"x\\":1}"');
    // completed response carries the function_call item
    const completedLine = text.split("\n").find((l) => l.startsWith("data: ") && l.includes("response.completed"));
    expect(completedLine).toBeDefined();
    const completed = JSON.parse(completedLine!.slice(6));
    expect(completed.response.output.some((o: { type: string }) => o.type === "function_call")).toBe(true);
  });

  it("developer role maps to system", () => {
    const req = parseChatCompletionsRequest({
      model: "m",
      messages: [{ role: "developer", content: "be terse" }],
    });
    expect(req.messages[0]!.role).toBe("system");
  });

  it("anthropic thinking blocks round-trip with signature", () => {
    const req = parseAnthropicRequest({
      model: "claude-haiku-4-5",
      max_tokens: 8000,
      thinking: { type: "enabled", budget_tokens: 4096 },
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "sig123" }, { type: "text", text: "a" }] },
        { role: "user", content: "more" },
      ],
    });
    const body = buildZenRequestBody("messages", req, false) as {
      messages: { role: string; content: { type: string; thinking?: string; signature?: string }[] }[];
    };
    const assistant = body.messages.find((m) => m.role === "assistant")!;
    const thinking = assistant.content.find((b) => b.type === "thinking");
    expect(thinking).toMatchObject({ thinking: "hmm", signature: "sig123" });
    // thinking enabled → no top_p, temperature forced to 1
    expect((body as unknown as Record<string, unknown>)["top_p"]).toBeUndefined();
    expect((body as unknown as Record<string, unknown>)["temperature"]).toBe(1);
  });
});

describe("tool name aliasing", () => {
  const LONG = "zcode__mcp__filesystem__read_file_contents_with_line_numbers_and_ranges"; // 71 chars

  it("aliases long names in built bodies and remaps responses back", async () => {
    const { mapperForRequest, remapCanonicalResponse } = await import("../src/tools");
    const req = parseResponsesRequest({
      model: "muse-spark-1.3-contributor-free",
      max_output_tokens: 100,
      input: [{ role: "user", content: "read it" }],
      tools: [{ type: "function", name: LONG, description: "d", parameters: { type: "object", properties: {} } }],
    });
    const mapper = mapperForRequest(req);
    expect(mapper.active).toBe(true);

    const body = buildZenRequestBody("responses", req, false, mapper) as { tools: { name: string }[] };
    const alias = body.tools[0]!.name;
    expect(alias).toMatch(/^t_[0-9a-f]{10}$/);
    expect(alias.length).toBeLessThanOrEqual(64);

    // upstream echoes the alias → caller sees the original
    const upstream = JSON.stringify({
      id: "resp_x",
      model: "m",
      status: "completed",
      output: [{ type: "function_call", call_id: "c1", name: alias, arguments: "{}" }],
    });
    const c = upstreamToCanonical("responses", upstream, "m");
    const remapped = remapCanonicalResponse(c, mapper);
    expect((remapped.output[0] as { name: string }).name).toBe(LONG);
  });

  it("aliases history tool_use for the anthropic dialect and forced tool_choice", async () => {
    const { mapperForRequest } = await import("../src/tools");
    const req = parseAnthropicRequest({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "bad name with spaces and more than sixty four characters total yes really long!!", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
      ],
      tools: [{ name: "bad name with spaces and more than sixty four characters total yes really long!!", description: "d", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: "bad name with spaces and more than sixty four characters total yes really long!!" },
    });
    const mapper = mapperForRequest(req);
    const body = buildZenRequestBody("messages", req, false, mapper) as {
      tools: { name: string }[];
      tool_choice: { type: string; name: string };
      messages: { role: string; content: { type: string; name?: string }[] }[];
    };
    const alias = body.tools[0]!.name;
    expect(alias).toMatch(/^t_[0-9a-f]{10}$/);
    expect(body.tool_choice.name).toBe(alias);
    const assistant = body.messages.find((m) => m.role === "assistant")!;
    expect(assistant.content[0]!.name).toBe(alias);
    // deterministic across mapper instances (stable across turns)
    const mapper2 = mapperForRequest(req);
    expect((buildZenRequestBody("messages", req, false, mapper2) as typeof body).tools[0]!.name).toBe(alias);
  });

  it("leaves valid names untouched (mapper inactive)", async () => {
    const { mapperForRequest } = await import("../src/tools");
    const req = parseChatCompletionsRequest({
      model: "big-pickle",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object" } } }],
    });
    const mapper = mapperForRequest(req);
    expect(mapper.active).toBe(false);
    const body = buildZenRequestBody("chat", req, false, mapper) as { tools: { function: { name: string } }[] };
    expect(body.tools[0]!.function.name).toBe("get_weather");
  });
});

describe("empty-response handling (muse reasoning-only answers)", () => {
  it("captures text delivered only in output_text.done (no deltas)", async () => {
    const sseText =
      `event: response.created\ndata: {"type":"response.created","response":{"id":"r1","model":"m"}}\n\n` +
      `event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","role":"assistant"}}\n\n` +
      `event: response.output_text.done\ndata: {"type":"response.output_text.done","output_index":0,"text":"the whole answer at once"}\n\n` +
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":2}}}\n\n`;
    const events = await collect(parseResponsesEvents(streamFromText(sseText)));
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta).join("");
    expect(text).toBe("the whole answer at once");
  });

  it("recovers text from response.completed when never streamed", async () => {
    const sseText =
      `event: response.created\ndata: {"type":"response.created","response":{"id":"r2","model":"m"}}\n\n` +
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"r2","usage":{"input_tokens":1,"output_tokens":2},"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"late text"}]}]}}\n\n`;
    const events = await collect(parseResponsesEvents(streamFromText(sseText)));
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta).join("");
    expect(text).toBe("late text");
  });

  it("promotes reasoning to text when the response is otherwise empty", async () => {
    const { eventsToCanonical, promoteReasoningIfEmpty, makeEmptyStreamGuard } = await import("../src/pipeline");
    const { canonicalToPublic } = await import("../src/build/responses");

    // non-stream: reasoning-only response gains a text part
    const c = eventsToCanonical(
      [
        { type: "reasoning_delta", delta: "Let me understand the task..." },
        { type: "stop", stopReason: "end" },
      ] as CanonicalEvent[],
      "x",
      "m",
    );
    const promoted = promoteReasoningIfEmpty(c);
    const out = canonicalToPublic("responses", promoted) as { output: { type: string }[] };
    expect(out.output.some((o) => o.type === "message")).toBe(true);

    // non-text reasoning stays untouched when real text exists
    const withText = eventsToCanonical(
      [
        { type: "reasoning_delta", delta: "thinking" },
        { type: "text_delta", delta: "answer" },
        { type: "stop", stopReason: "end" },
      ] as CanonicalEvent[],
      "y",
      "m",
    );
    const untouched = promoteReasoningIfEmpty(withText);
    expect(untouched.output.some((o) => o.type === "text" && o.text === "answer")).toBe(true);
    expect(untouched.output.filter((o) => o.type === "text")).toHaveLength(1);

    // streaming guard: reasoning-only stream emits the reasoning as text before stop
    const guard = makeEmptyStreamGuard();
    const emitted: CanonicalEvent[] = [];
    for (const ev of [
      { type: "reasoning_delta", delta: "all of the answer" },
      { type: "stop", stopReason: "end" },
    ] as CanonicalEvent[]) {
      emitted.push(...guard(ev));
    }
    const types = emitted.map((e) => e.type);
    expect(types).toEqual(["reasoning_delta", "text_delta", "stop"]);
    const textDelta = emitted.find((e) => e.type === "text_delta") as { delta: string };
    expect(textDelta.delta).toBe("all of the answer");

    // streaming guard: normal stream untouched
    const guard2 = makeEmptyStreamGuard();
    const normal: CanonicalEvent[] = [];
    for (const ev of [
      { type: "text_delta", delta: "hi" },
      { type: "stop", stopReason: "end" },
    ] as CanonicalEvent[]) {
      normal.push(...guard2(ev));
    }
    expect(normal.map((e) => e.type)).toEqual(["text_delta", "stop"]);
  });
});

describe("failure-mode regressions (second review pass)", () => {
  it("emits the upstream error before stop on response.failed", async () => {
    const sseText =
      `event: response.created\ndata: {"type":"response.created","response":{"id":"r","model":"m"}}\n\n` +
      `event: response.failed\ndata: {"type":"response.failed","response":{"id":"r","status":"failed","error":{"code":"server_error","message":"UPSTREAM_BOOM"}}}\n\n`;
    const events = await collect(parseResponsesEvents(streamFromText(sseText)));
    const errIdx = events.findIndex((e) => e.type === "error");
    const stopIdx = events.findIndex((e) => e.type === "stop");
    expect(errIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeLessThan(stopIdx);
    expect((events[errIdx] as { error: { message: string } }).error.message).toBe("UPSTREAM_BOOM");
  });

  it("does not double-count anthropic input tokens", async () => {
    const sseText =
      `event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":40}}}\n\n` +
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":40,"output_tokens":7}}\n\n`;
    const events = await collect(parseAnthropicEvents(streamFromText(sseText)));
    const usages = events.filter((e) => e.type === "usage") as { usage: { inputTokens: number; outputTokens: number } }[];
    const final = usages[usages.length - 1]!.usage;
    expect(final.inputTokens).toBe(40);
    expect(final.outputTokens).toBe(7);
  });

  it("replaces reasoning with text when promoting (no duplicate content)", async () => {
    const { eventsToCanonical, promoteReasoningIfEmpty } = await import("../src/pipeline");
    const c = eventsToCanonical(
      [{ type: "reasoning_delta", delta: "THE ANSWER" }, { type: "stop", stopReason: "end" }] as CanonicalEvent[],
      "x",
      "m",
    );
    const promoted = promoteReasoningIfEmpty(c);
    expect(promoted.output.filter((o) => o.type === "reasoning")).toHaveLength(0);
    expect(promoted.output.filter((o) => o.type === "text")).toHaveLength(1);
    expect((promoted.output[0] as { text: string }).text).toBe("THE ANSWER");
  });

  it("terminates a chat stream with finish_reason and [DONE] after an error", () => {
    const emit = createChatEmitter({ model: "m", id: "cc" });
    const chunks: Uint8Array[] = [];
    for (const ev of [
      { type: "text_delta", delta: "partial" },
      { type: "error", error: { type: "upstream_stalled", message: "boom" } },
    ] as CanonicalEvent[]) {
      chunks.push(...emit(ev));
    }
    const text = chunks.map((c) => new TextDecoder().decode(c)).join("");
    expect(text).toContain('"error"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  });

  it("keeps a tool call that was truncated mid-arguments", async () => {
    const { eventsToCanonical } = await import("../src/pipeline");
    const c = eventsToCanonical(
      [
        { type: "tool_call_start", index: 0, id: "c1", name: "fn" },
        { type: "tool_call_delta", index: 0, argsDelta: '{"a":1' },
      ] as CanonicalEvent[],
      "x",
      "m",
    );
    const calls = c.output.filter((o) => o.type === "tool_call") as { name: string; argumentsJson: string }[];
    expect(calls).toHaveLength(1);
    expect(calls[0]!.argumentsJson).toBe('{"a":1');
  });

  it("maps tool_choice and reasoning effort for the gemini dialect", () => {
    const req = parseChatCompletionsRequest({
      model: "gemini-3-flash",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "f" } },
      reasoning_effort: "high",
    });
    const body = buildZenRequestBody("gemini", req, false) as {
      toolConfig: { functionCallingConfig: { mode: string; allowedFunctionNames?: string[] } };
      generationConfig: { thinkingConfig?: { thinkingBudget: number } };
    };
    expect(body.toolConfig.functionCallingConfig.mode).toBe("ANY");
    expect(body.toolConfig.functionCallingConfig.allowedFunctionNames).toEqual(["f"]);
    expect(body.generationConfig.thinkingConfig!.thinkingBudget).toBeGreaterThan(0);
  });

  it("keeps auto/none tool_choice when thinking is enabled", () => {
    const req = parseAnthropicRequest({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      thinking: { type: "enabled", budget_tokens: 4096 },
      tool_choice: { type: "none" },
      tools: [{ name: "f", input_schema: { type: "object" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    const body = buildZenRequestBody("messages", req, false) as { tool_choice?: { type: string } };
    expect(body.tool_choice).toEqual({ type: "none" });
  });

  it("omits assistant turns that carry neither text nor tool calls", () => {
    const req = parseResponsesRequest({
      model: "big-pickle",
      input: [
        { role: "user", content: "hi" },
        { type: "reasoning", id: "rs_1", summary: [] },
        { role: "user", content: "again" },
      ],
    });
    const body = buildZenRequestBody("chat", req, false) as { messages: { role: string; content: unknown }[] };
    const emptyAssistant = body.messages.find((m) => m.role === "assistant" && m.content === null);
    expect(emptyAssistant).toBeUndefined();
  });

  it("reports a failed upstream as failed in the responses format", async () => {
    const { canonicalToPublic } = await import("../src/build/responses");
    const out = canonicalToPublic("responses", {
      id: "r",
      model: "m",
      output: [{ type: "text", text: "partial" }],
      stopReason: "error",
      created: 1,
    }) as { status: string; error: unknown };
    expect(out.status).toBe("failed");
    expect(out.error).toBeTruthy();
  });
});

describe("connection-drop retry policy", () => {
  it("classifies connectivity failures, timeouts, aborts and subrequest limits", async () => {
    const { classifyFailure, isConnectivityFailure } = await import("../src/retry");
    expect(classifyFailure(new TypeError("Network connection lost."))).toBe("network");
    expect(classifyFailure(new Error("fetch failed"))).toBe("network");
    expect(classifyFailure(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe("network");
    expect(classifyFailure(new Error("getaddrinfo ENOTFOUND opencode.ai"))).toBe("network");
    const timeout = new DOMException("zen did not respond within 20s", "TimeoutError");
    expect(classifyFailure(timeout)).toBe("timeout");
    const abort = new DOMException("aborted", "AbortError");
    expect(classifyFailure(abort, true)).toBe("client_abort");
    // the same abort without a client disconnect is a dropped connection
    expect(classifyFailure(abort, false)).toBe("network");
    expect(classifyFailure(new Error("Too many subrequests."))).toBe("subrequest_limit");
    expect(classifyFailure(new Error("invalid_request_error: bad model"))).toBe("other");

    expect(isConnectivityFailure("network")).toBe(true);
    expect(isConnectivityFailure("timeout")).toBe(true);
    expect(isConnectivityFailure("client_abort")).toBe(false);
    expect(isConnectivityFailure("subrequest_limit")).toBe(false);
    expect(isConnectivityFailure("other")).toBe(false);
  });

  it("reconnect backoff ramps quickly then holds under the cap", async () => {
    const { networkRetryDelay } = await import("../src/retry");
    const cap = 5_000;
    const d1 = networkRetryDelay(1, cap);
    const d3 = networkRetryDelay(3, cap);
    const d10 = networkRetryDelay(10, cap);
    expect(d1).toBeLessThan(1_000);
    expect(d3).toBeGreaterThanOrEqual(d1);
    expect(d10).toBeLessThanOrEqual(cap + 400);
    // 150 attempts must stay in the minutes range, not hours
    let total = 0;
    for (let i = 1; i <= 150; i++) total += networkRetryDelay(i, cap);
    expect(total).toBeLessThan(15 * 60 * 1000);
  });

  it("defaults to 150 network retries and keeps budgets separate", async () => {
    const { retryPolicyFromEnv } = await import("../src/retry");
    const def = retryPolicyFromEnv({});
    expect(def.networkRetries).toBe(150);
    expect(def.statusRetries).toBe(3);
    expect(def.networkDeadlineMs).toBe(900_000);

    const custom = retryPolicyFromEnv({ UPSTREAM_NETWORK_RETRIES: "400", UPSTREAM_RETRIES: 5 });
    expect(custom.networkRetries).toBe(400);
    expect(custom.statusRetries).toBe(5);
    // out-of-range values clamp instead of breaking the loop
    expect(retryPolicyFromEnv({ UPSTREAM_NETWORK_RETRIES: 99999 }).networkRetries).toBe(1000);
    expect(retryPolicyFromEnv({ UPSTREAM_NETWORK_RETRIES: 0 }).networkRetries).toBe(1);
    expect(retryPolicyFromEnv({ UPSTREAM_NETWORK_RETRIES: "nonsense" }).networkRetries).toBe(150);
  });

  it("honors Retry-After for status retries and caps it", async () => {
    const { statusRetryDelay } = await import("../src/retry");
    expect(statusRetryDelay(1, 7)).toBe(7000);
    expect(statusRetryDelay(1, 600)).toBe(30_000);
    expect(statusRetryDelay(1)).toBeLessThanOrEqual(9_000);
    expect(statusRetryDelay(5)).toBeLessThanOrEqual(9_000);
  });
});

describe("maximum reasoning effort", () => {
  it("picks the highest advertised level per model and steps down on rejection", async () => {
    const { planMaxEffort, lowerEffort, isReasoningRejection, EFFORT_CHAIN } = await import("../src/reasoning");
    expect(planMaxEffort("gpt-5.6-sol").effort).toBe("max");
    expect(planMaxEffort("muse-spark-1.3-contributor-free").effort).toBe("xhigh");
    expect(planMaxEffort("gemini-3-flash").effort).toBe("high");
    expect(planMaxEffort("claude-opus-4-5").effort).toBe("high");
    // models with no reasoning support get no reasoning controls at all
    expect(planMaxEffort("qwen3-coder").effort).toBeUndefined();
    expect(planMaxEffort("big-pickle").effort).toBeUndefined();
    // unknown/new model: start at the ceiling and let the chain correct it
    expect(planMaxEffort("gpt-9-brand-new").effort).toBe("max");

    expect(EFFORT_CHAIN[0]).toBe("max");
    expect(lowerEffort("max")).toBe("xhigh");
    expect(lowerEffort("xhigh")).toBe("high");
    expect(lowerEffort("high")).toBe("medium");
    expect(lowerEffort("medium")).toBe("low");
    expect(lowerEffort("low")).toBe("minimal");
    expect(lowerEffort("minimal")).toBe("none");
    expect(lowerEffort("none")).toBeUndefined();

    expect(isReasoningRejection("only 'high' is supported for reasoning.effort")).toBe(true);
    expect(isReasoningRejection("budget_tokens must be less than max_tokens")).toBe(true);
    expect(isReasoningRejection("unknown parameter logprobs")).toBe(false);
  });

  it("remembers the level a model accepted so later turns skip the probe", async () => {
    const { planMaxEffort, rememberEffort, resetLearnedEffort } = await import("../src/reasoning");
    resetLearnedEffort();
    try {
      expect(planMaxEffort("brand-new-model").effort).toBe("max");
      rememberEffort("brand-new-model", "medium");
      expect(planMaxEffort("brand-new-model")).toEqual({ effort: "medium", known: true });
      rememberEffort("brand-new-model", undefined);
      expect(planMaxEffort("brand-new-model")).toEqual({ effort: undefined, known: true });
    } finally {
      resetLearnedEffort();
    }
  });

  it("sends the effort in each dialect's own shape", async () => {
    const chat = parseChatCompletionsRequest({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" });
    expect((buildZenRequestBody("chat", chat, false) as { reasoning_effort: string }).reasoning_effort).toBe("max");

    const resp = parseResponsesRequest({ model: "gpt-5.6-sol", input: "hi", reasoning: { effort: "xhigh" } });
    expect((buildZenRequestBody("responses", resp, false) as { reasoning: { effort: string } }).reasoning.effort).toBe("xhigh");

    const gem = parseChatCompletionsRequest({ model: "gemini-3-flash", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" });
    const gemBody = buildZenRequestBody("gemini", gem, false) as { generationConfig: { thinkingConfig: { thinkingBudget: number; includeThoughts?: boolean } } };
    expect(gemBody.generationConfig.thinkingConfig.thinkingBudget).toBeGreaterThan(8000);
    expect(gemBody.generationConfig.thinkingConfig.includeThoughts).toBe(true);
  });

  it("clamps the anthropic thinking budget below max_tokens and skips it when there is no room", () => {
    const roomy = parseAnthropicRequest({
      model: "claude-opus-5",
      max_tokens: 40_000,
      thinking: { type: "enabled", budget_tokens: 30_000 },
      messages: [{ role: "user", content: "hi" }],
    });
    const roomyBody = buildZenRequestBody("messages", { ...roomy, reasoningEffort: "max" }, false) as {
      thinking?: { budget_tokens: number };
      max_tokens: number;
    };
    expect(roomyBody.thinking!.budget_tokens).toBeLessThan(roomyBody.max_tokens);

    const tight = parseAnthropicRequest({
      model: "claude-opus-5",
      max_tokens: 512,
      messages: [{ role: "user", content: "hi" }],
    });
    const tightBody = buildZenRequestBody("messages", { ...tight, reasoningEffort: "max" }, false) as { thinking?: unknown };
    expect(tightBody.thinking).toBeUndefined();
  });

  it("defaults to 8 empty-answer retries (enough to reach the token cap)", async () => {
    const { retryPolicyFromEnv, emptyRetryDelay } = await import("../src/retry");
    expect(retryPolicyFromEnv({}).emptyRetries).toBe(8);
    expect(retryPolicyFromEnv({ UPSTREAM_EMPTY_RETRIES: 5 }).emptyRetries).toBe(5);
    expect(retryPolicyFromEnv({ UPSTREAM_EMPTY_RETRIES: 0 }).emptyRetries).toBe(0);
    expect(emptyRetryDelay(1)).toBeLessThan(1_000);
    expect(emptyRetryDelay(50)).toBeLessThanOrEqual(3_300);
  });

  it("treats reasoning-only and empty responses correctly for the retry decision", async () => {
    const { hasUsableOutput } = await import("../src/pipeline");
    expect(hasUsableOutput({ id: "a", model: "m", output: [], stopReason: "end", created: 1 })).toBe(false);
    expect(hasUsableOutput({ id: "a", model: "m", output: [{ type: "text", text: "   " }], stopReason: "end", created: 1 })).toBe(false);
    expect(hasUsableOutput({ id: "a", model: "m", output: [{ type: "text", text: "hi" }], stopReason: "end", created: 1 })).toBe(true);
    expect(hasUsableOutput({ id: "a", model: "m", output: [{ type: "reasoning", text: "thought" }], stopReason: "end", created: 1 })).toBe(true);
    expect(
      hasUsableOutput({ id: "a", model: "m", output: [{ type: "tool_call", id: "c", name: "f", argumentsJson: "{}" }], stopReason: "end", created: 1 }),
    ).toBe(true);
  });

  it("does not retry an empty answer that ended in an upstream error", async () => {
    const { isRetryableEmpty } = await import("../src/pipeline");
    expect(isRetryableEmpty({ id: "a", model: "m", output: [], stopReason: "end", created: 1 })).toBe(true);
    expect(isRetryableEmpty({ id: "a", model: "m", output: [], stopReason: "error", created: 1 })).toBe(false);
    expect(
      isRetryableEmpty({ id: "a", model: "m", output: [{ type: "text", text: "hi" }], stopReason: "error", created: 1 }),
    ).toBe(false);
  });
});

describe("upstream identity", () => {
  it("uses one weekly fallback session instead of a fresh id per request", async () => {
    const { weeklySessionId } = await import("../src/identity");
    const monday = weeklySessionId(new Date("2026-10-19T00:00:00Z"));
    const sunday = weeklySessionId(new Date("2026-10-25T23:59:59Z"));
    const nextMonday = weeklySessionId(new Date("2026-10-26T00:00:00Z"));
    expect(monday).toBe(sunday);
    expect(nextMonday).not.toBe(monday);
    expect(monday).toMatch(/^ses_conv_w\d{4}_\d{2}$/);
  });

  it("uses a stable session under the proxy project when opencode is installed", async () => {
    const { defaultSessionId, weeklySessionId } = await import("../src/identity");
    const project = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const date = new Date("2026-10-19T00:00:00Z");
    expect(defaultSessionId({ OPENCODE_INSTALLED: "1", OPENCODE_PROJECT_ID: project }, date)).toBe(`ses_conv_${project}`);
    // installed but no project id: fall through to the weekly fallback
    expect(defaultSessionId({ OPENCODE_INSTALLED: "1" }, date)).toBe(weeklySessionId(date));
    // not installed: weekly fallback even if a project id happens to be present
    expect(defaultSessionId({ OPENCODE_PROJECT_ID: project }, date)).toBe(weeklySessionId(date));
  });

  it("uses the configured project id, otherwise a stable per-isolate uuid", async () => {
    const { proxyProjectId } = await import("../src/identity");
    const project = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(proxyProjectId({ OPENCODE_PROJECT_ID: project })).toBe(project);
    expect(proxyProjectId({})).toBe(proxyProjectId({}));
  });
});

describe("geo-block retry", () => {
  it("recognizes region-block messages", async () => {
    const { isGeoBlockMessage } = await import("../src/retry");
    expect(isGeoBlockMessage("This model is not available in your country.")).toBe(true);
    expect(isGeoBlockMessage("Model is not available in your region")).toBe(true);
    expect(isGeoBlockMessage("geo-blocked by provider")).toBe(true);
    expect(isGeoBlockMessage("Invalid API key.")).toBe(false);
    expect(isGeoBlockMessage("Rate limit exceeded.")).toBe(false);
  });

  it("retries geo-blocks without a cap unless configured", async () => {
    const { retryPolicyFromEnv } = await import("../src/retry");
    expect(retryPolicyFromEnv({}).geoBlockRetries).toBe(Number.POSITIVE_INFINITY);
    expect(retryPolicyFromEnv({ UPSTREAM_GEOBLOCK_RETRIES: 9 }).geoBlockRetries).toBe(9);
    expect(retryPolicyFromEnv({ UPSTREAM_GEOBLOCK_RETRIES: 0 }).geoBlockRetries).toBe(0);
    expect(retryPolicyFromEnv({ UPSTREAM_GEOBLOCK_RETRIES: "" }).geoBlockRetries).toBe(Number.POSITIVE_INFINITY);
    expect(retryPolicyFromEnv({ UPSTREAM_GEOBLOCK_RETRIES: "-1" }).geoBlockRetries).toBe(Number.POSITIVE_INFINITY);
  });
});
