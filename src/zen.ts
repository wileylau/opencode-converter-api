/**
 * opencode zen upstream client.
 *
 * Verified upstream behavior (tested against https://opencode.ai/zen/v1):
 *  - Free models work with NO key when the request looks like the opencode CLI:
 *      User-Agent: opencode/<version>      (the load-bearing header)
 *      Authorization: Bearer public        (what the CLI sends when unauthenticated)
 *      x-opencode-client: cli
 *      x-opencode-session / x-opencode-request / x-opencode-project
 *  - Without the opencode User-Agent, free models 429 with FreeUsageLimitError.
 *  - Paid models require a real key: Authorization: Bearer <zen key>.
 *  - Native endpoints: /chat/completions (openai), /messages (anthropic),
 *    /responses (openai responses), /models/{model}:generateContent (gemini),
 *    /models (model list).
 *  - Model families are endpoint-locked: gpt/grok/muse → /responses,
 *    claude/qwen → /messages, glm/kimi/minimax/deepseek/big-pickle etc → /chat/completions,
 *    gemini-* → /models/{model}:generateContent. Wrong endpoint → 500/401.
 */

import { getOpencodeVersion, fallbackVersion } from "./version";
import { stableProjectId } from "./util";

export const ZEN_BASE = "https://opencode.ai/zen/v1";

export type ZenEndpoint = "chat" | "messages" | "responses" | "gemini";

export interface ZenTarget {
  endpoint: ZenEndpoint;
  /** e.g. big-pickle, claude-haiku-4-5 */
  model: string;
  url: string;
}

/** Resolve the zen base URL, allowing an env override (tests / gateways). */
export function zenBaseFromEnv(env: Record<string, unknown> | undefined): string {
  const base = env?.["UPSTREAM_BASE"];
  return typeof base === "string" && /^https?:\/\//.test(base) ? base.replace(/\/+$/, "") : ZEN_BASE;
}

export function buildZenUrl(endpoint: ZenEndpoint, model: string, stream = false, base: string = ZEN_BASE): string {
  switch (endpoint) {
    case "chat":
      return `${base}/chat/completions`;
    case "messages":
      return `${base}/messages`;
    case "responses":
      return `${base}/responses`;
    case "gemini":
      return stream
        ? `${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`
        : `${base}/models/${encodeURIComponent(model)}:generateContent`;
  }
}

/**
 * Decide which native zen endpoint serves a model.
 * `known` is the set of model ids from the live /models list, mapped to families.
 */
export function pickEndpoint(
  model: string,
  modelFamilies: Map<string, string> | null,
  stream = false,
  base: string = ZEN_BASE,
): ZenTarget {
  const normalized = model.trim();
  const family = modelFamilies?.get(normalized);
  let endpoint: ZenEndpoint;
  if (family === "openai-responses") endpoint = "responses";
  else if (family === "anthropic") endpoint = "messages";
  else if (family === "openai-chat") endpoint = "chat";
  else if (family === "gemini") endpoint = "gemini";
  else if (normalized.startsWith("gpt-") || normalized.startsWith("grok-") || normalized.startsWith("muse-")) endpoint = "responses";
  else if (normalized.startsWith("claude-") || normalized.startsWith("qwen")) endpoint = "messages";
  else if (normalized.startsWith("gemini-")) endpoint = "gemini";
  else endpoint = "chat";
  return { endpoint, model: normalized, url: buildZenUrl(endpoint, normalized, stream, base) };
}

export class ZenError extends Error {
  status: number;
  upstreamType: string;
  retryAfter?: number;
  constructor(status: number, type: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.upstreamType = type;
    this.retryAfter = retryAfter;
  }
}

export interface ZenAuth {
  /** caller's zen api key, or null for anonymous free-tier access */
  apiKey: string | null;
  /** anonymous access uses the literal token "public" like the real CLI does */
  anonymous: boolean;
}

export interface ZenRequestOptions {
  auth: ZenAuth;
  /** body already encoded in the target endpoint's native format */
  body: string;
  target: ZenTarget;
  stream: boolean;
  /** client-provided stable session id (x-session-id) for zen rate-limit identity */
  sessionId?: string;
  /** response format identity, forwarded to callers for diagnostics */
  signal?: AbortSignal;
}

export interface ZenCallContext {
  env: Record<string, unknown>;
  ctx?: { waitUntil(p: Promise<unknown>): void };
}

let sessionCounter = 0;

/**
 * Headers that make the request look exactly like the opencode CLI talking to zen.
 * Verified against the CLI source (packages/opencode/src/session/llm/request.ts):
 *   User-Agent: opencode/<version>  (+ x-opencode-session/request/client/project)
 */
export async function zenHeaders(
  env: Record<string, unknown>,
  ctx: { waitUntil(p: Promise<unknown>): void } | undefined,
  auth: ZenAuth,
  extraHeaders: Record<string, string>,
  sessionId?: string,
): Promise<{ headers: Record<string, string>; version: string }> {
  let version: string;
  try {
    version = await getOpencodeVersion(env, ctx);
  } catch {
    version = fallbackVersion(env);
  }
  // A caller-supplied stable session id groups requests under one zen session,
  // which beats a fresh random id per request for rate-limit accounting.
  const session =
    sessionId && /^[-\w.]{8,128}$/.test(sessionId)
      ? sessionId
      : `ses_conv_${Date.now().toString(36)}_${(sessionCounter++).toString(36)}_${crypto.getRandomValues(new Uint8Array(4)).join("")}`;
  const request = `req_${crypto.randomUUID()}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": `opencode/${version}`,
    "x-opencode-client": "cli",
    "x-opencode-session": session,
    "x-opencode-request": request,
    "x-opencode-project": stableProjectId(),
    ...extraHeaders,
  };
  if (auth.apiKey) {
    headers["authorization"] = `Bearer ${auth.apiKey}`;
  } else {
    // opencode CLI sends `apiKey: "public"` when unauthenticated; free models accept it.
    headers["authorization"] = "Bearer public";
  }
  return { headers, version };
}

/** Default deadline for zen to send response headers. Overridable via UPSTREAM_HEADER_TIMEOUT_MS. */
export const DEFAULT_HEADER_TIMEOUT_MS = 20_000;

export function numEnv(env: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const v = env?.[key];
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Perform a request to zen. Returns the raw fetch Response (body unconsumed)
 * plus the AbortController governing it, so callers can enforce a body deadline
 * or abort a stalled stream.
 *
 * Timeout layers (this function owns the first):
 *   1. header timeout — zen must respond within UPSTREAM_HEADER_TIMEOUT_MS
 *   2. client signal  — caller aborts ⇒ upstream aborts
 *   3. body/stall deadlines — owned by the pipeline via the returned controller
 */
export async function callZen(opts: ZenRequestOptions & ZenCallContext): Promise<{
  response: Response;
  version: string;
  controller: AbortController;
}> {
  const extraHeaders: Record<string, string> = {};
  if (opts.target.endpoint === "messages") {
    extraHeaders["anthropic-version"] = "2023-06-01";
    // the real CLI talks to zen's /messages through @ai-sdk/anthropic, which sends x-api-key
    if (opts.auth.apiKey) extraHeaders["x-api-key"] = opts.auth.apiKey;
  } else if (opts.target.endpoint === "gemini" && opts.auth.apiKey) {
    // Google SDK style auth header
    extraHeaders["x-goog-api-key"] = opts.auth.apiKey;
  }
  const { headers, version } = await zenHeaders(opts.env, opts.ctx, opts.auth, extraHeaders, opts.sessionId);

  const controller = new AbortController();
  const headerTimeoutMs = numEnv(opts.env, "UPSTREAM_HEADER_TIMEOUT_MS", DEFAULT_HEADER_TIMEOUT_MS);
  const headerTimer =
    headerTimeoutMs > 0
      ? setTimeout(
          () => controller.abort(new DOMException(`zen did not respond within ${Math.max(1, Math.round(headerTimeoutMs / 1000))}s`, "TimeoutError")),
          headerTimeoutMs,
        )
      : undefined;
  // The listener stays attached for the life of the upstream response so a client
  // disconnect mid-stream also tears down the subrequest, not just a pre-header abort.
  const onClientAbort = () => controller.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onClientAbort, { once: true });
  }

  try {
    const response = await fetch(opts.target.url, {
      method: "POST",
      headers,
      body: opts.body,
      signal: controller.signal,
    });
    return { response, version, controller };
  } catch (err) {
    if (opts.signal) opts.signal.removeEventListener("abort", onClientAbort);
    throw err;
  } finally {
    if (headerTimer) clearTimeout(headerTimer);
  }
}

/**
 * Read the live zen model list. Returns Map<modelId, familyTag> plus raw entries.
 * Cached in memory for 5 minutes; falls back to a static snapshot on failure.
 */
export interface ZenModelInfo {
  id: string;
  created: number;
}

const STATIC_MODEL_FALLBACK: ZenModelInfo[] = [
  { id: "big-pickle", created: 1788523896 },
  { id: "mimo-v2.5-free", created: 1788523896 },
  { id: "ling-3.0-flash-fin-free", created: 1788523896 },
  { id: "nemotron-3-ultra-free", created: 1788523896 },
  { id: "nemotron-3.5-lightning-free", created: 1788523896 },
  { id: "muse-spark-1.3-contributor-free", created: 1788523896 },
  { id: "muse-spark-1.2-contributor-free", created: 1788523896 },
  { id: "gpt-5.6-sol", created: 1788523896 },
  { id: "gpt-5.6-luna", created: 1788523896 },
  { id: "claude-haiku-4-5", created: 1788523896 },
  { id: "gemini-3-flash", created: 1788523896 },
];

let modelCache: { at: number; models: ZenModelInfo[]; base: string } | null = null;
const MODEL_TTL = 5 * 60 * 1000;

export interface ZenModelList {
  models: ZenModelInfo[];
  /** true when the list is stale or the built-in fallback: never use it to reject models */
  stale: boolean;
}

export async function fetchZenModels(env?: Record<string, unknown>): Promise<ZenModelList> {
  const base = zenBaseFromEnv(env);
  const now = Date.now();
  if (modelCache && modelCache.base === base && now - modelCache.at < MODEL_TTL) {
    return { models: modelCache.models, stale: false };
  }
  try {
    const res = await fetch(`${base}/models`, {
      headers: { accept: "application/json", "user-agent": "opencode-converter-api" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as { data?: { id?: string; created?: number }[] };
    const models = (data.data ?? [])
      .filter((m): m is { id: string; created?: number } => typeof m.id === "string")
      .map((m) => ({ id: m.id, created: m.created ?? 0 }));
    if (models.length) {
      modelCache = { at: now, models, base };
      return { models, stale: false };
    }
    throw new Error("empty model list");
  } catch {
    // stale-but-known beats empty, but callers must not reject unknown ids from it
    if (modelCache && modelCache.base === base) return { models: modelCache.models, stale: true };
    return { models: STATIC_MODEL_FALLBACK, stale: true };
  }
}

/**
 * Family classification: zen routes each model family to exactly one native API.
 * The docs table maps: gpt/grok/muse → responses; claude/qwen → messages;
 * deepseek/minimax/glm/kimi/big-pickle/mimo/ling/nemotron → chat; gemini → gemini.
 * `liveIds` is the set of ids currently in the zen /models list.
 */
export function classifyModel(id: string): "openai-responses" | "anthropic" | "openai-chat" | "gemini" {
  if (id.startsWith("gpt-") || id.startsWith("grok-") || id.startsWith("muse-")) return "openai-responses";
  if (id.startsWith("claude-") || id.startsWith("qwen")) return "anthropic";
  if (id.startsWith("gemini-")) return "gemini";
  return "openai-chat";
}
