/**
 * Transparent tool-name aliasing.
 *
 * All upstream dialects limit function names to 64 chars with restricted
 * charsets (OpenAI: ≤64; Anthropic: ^[a-zA-Z0-9_-]{1,64}$; Gemini similar).
 * Agent clients (ZCode/OpenCode/MCP) routinely send longer names, which zen
 * rejects with 400 `name` must be at most 64 characters".
 *
 * Long/invalid names are rewritten to short deterministic aliases (t_<hash>)
 * on the way in — consistently across tool definitions, history, and tool
 * results — and mapped back to the caller's original names in every response
 * and stream event. The hash makes aliases stable across turns of a session.
 */

import type { CanonicalRequest, CanonicalEvent, CanonicalResponse } from "./canonical";

const VALID_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export function toolNeedsAlias(name: string): boolean {
  return !VALID_NAME.test(name);
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0") + (s.length % 100).toString(16).padStart(2, "0");
}

export class ToolNameMapper {
  private toAlias = new Map<string, string>();
  private toOriginal = new Map<string, string>();

  alias(name: string): string {
    if (!name || !toolNeedsAlias(name)) return name;
    const existing = this.toAlias.get(name);
    if (existing) return existing;
    let alias = `t_${fnv1a(name)}`;
    while (this.toOriginal.has(alias)) alias = `t_${fnv1a(alias)}`;
    this.toAlias.set(name, alias);
    this.toOriginal.set(alias, name);
    return alias;
  }

  original(name: string): string {
    return this.toOriginal.get(name) ?? name;
  }

  get active(): boolean {
    return this.toAlias.size > 0;
  }
}

/** Pre-populate the mapper from the request's tool list and tool_use history. */
export function mapperForRequest(req: CanonicalRequest): ToolNameMapper {
  const mapper = new ToolNameMapper();
  for (const t of req.tools) mapper.alias(t.name);
  for (const msg of req.messages) {
    if (typeof msg.content === "string") continue;
    for (const b of msg.content) {
      if (b.type === "tool_use") mapper.alias(b.name);
    }
  }
  return mapper;
}

/** Restore original tool names on a non-streaming upstream response. */
export function remapCanonicalResponse(c: CanonicalResponse, mapper: ToolNameMapper): CanonicalResponse {
  if (!mapper.active) return c;
  return {
    ...c,
    output: c.output.map((o) => (o.type === "tool_call" ? { ...o, name: mapper.original(o.name) } : o)),
  };
}

/** Restore original tool names on a canonical event stream. */
export async function* remapEvents(
  iter: AsyncGenerator<CanonicalEvent>,
  mapper: ToolNameMapper,
): AsyncGenerator<CanonicalEvent> {
  if (!mapper.active) {
    yield* iter;
    return;
  }
  for await (const ev of iter) {
    yield ev.type === "tool_call_start" ? { ...ev, name: mapper.original(ev.name) } : ev;
  }
}
