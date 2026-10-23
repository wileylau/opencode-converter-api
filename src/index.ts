/**
 * Worker entrypoint: CORS + routing + auth extraction + /v1/models + 3 completion endpoints.
 *
 * Public API (all under /v1):
 *   GET  /v1/models                  — OpenAI-style model list (live from zen)
 *   GET  /v1/models/{id}             — model detail
 *   POST /v1/chat/completions        — OpenAI Chat Completions compatible
 *   POST /v1/messages                — Anthropic Messages compatible
 *   POST /v1/responses               — OpenAI Responses compatible
 *
 * Auth (caller's own opencode zen key; omit entirely for free models):
 *   Authorization: Bearer <key>   |   x-api-key: <key>   |   x-goog-api-key: <key>   |   ?key=<key>
 * Optional shared gateway key (set via `wrangler secret put GATEWAY_KEY`):
 *   x-oc-gateway-key: <key>       (also accepted as Bearer when GATEWAY_KEY is set and
 *                                  the bearer token equals it — then zen key comes from
 *                                  the x-zen-key header or DEFAULT_ZEN_KEY secret)
 */

import { handleCompletion, type InboundFormat } from "./pipeline";
import { fetchZenModels, classifyModel, ZEN_BASE } from "./zen";
import { corsPreflight, jsonResponse } from "./util";
import { getOpencodeVersion, fallbackVersion } from "./version";

interface WorkerEnv {
  GATEWAY_KEY?: string;
  DEFAULT_ZEN_KEY?: string;
  FALLBACK_VERSION?: string;
  UPSTREAM_BASE?: string;
  /** set by scripts/dev.mjs when an opencode install is detected */
  OPENCODE_INSTALLED?: string;
  /** persisted proxy project id (created by scripts/dev.mjs) */
  OPENCODE_PROJECT_ID?: string;
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") return corsPreflight(request);

    if (request.method === "GET" && (path === "/" || path === "")) {
      return jsonResponse({
        service: "opencode-converter-api",
        version: await safeVersion(env, ctx),
        upstream: ZEN_BASE,
        endpoints: ["/v1/models", "/v1/chat/completions", "/v1/messages", "/v1/responses"],
        auth: "send your own opencode zen api key via Authorization: Bearer <key> (optional for free models)",
      });
    }

    if (!path.startsWith("/v1")) {
      return jsonResponse({ error: { message: `not found: ${path}`, type: "invalid_request_error" } }, 404);
    }

    // ---- auth extraction ----
    const auth = extractAuth(url, request, env);

    const gatewayOk = !env.GATEWAY_KEY || timingSafeEqual(auth.gatewayKey, env.GATEWAY_KEY);
    const gatewayDenied = () =>
      jsonResponse(
        { error: { message: "invalid or missing gateway key (x-oc-gateway-key)", type: "authentication_error" } },
        401,
      );

    // ---- models ----
    if (path === "/v1/models" && request.method === "GET") {
      if (!gatewayOk) return gatewayDenied();
      return handleModels(env, "list");
    }
    const modelDetail = /^\/v1\/models\/([^/]+)$/.exec(path);
    if (modelDetail && request.method === "GET") {
      if (!gatewayOk) return gatewayDenied();
      let id: string;
      try {
        id = decodeURIComponent(modelDetail[1]!);
      } catch {
        return jsonResponse({ error: { message: "invalid model id encoding", type: "invalid_request_error" } }, 400);
      }
      return handleModels(env, "detail", id);
    }

    // ---- completions ----
    const completionRoutes: Record<string, InboundFormat> = {
      "/v1/chat/completions": "chat",
      "/v1/messages": "messages",
      "/v1/responses": "responses",
    };
    const format = completionRoutes[path];
    if (format && request.method === "POST") {
      if (!gatewayOk) return gatewayDenied();
      let body: Record<string, unknown>;
      try {
        const raw = await request.text();
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch (e) {
        return jsonResponse({ error: { message: `invalid JSON body: ${(e as Error).message}`, type: "invalid_request_error" } }, 400);
      }

      return handleCompletion({
        env: envWithBase(env),
        ctx,
        format,
        body,
        auth: { apiKey: auth.zenKey },
        sessionId: clientSessionId(request),
        signal: request.signal,
      });
    }

    // POST /v1/responses/{model} — model-in-URL convenience route
    const responsesModel = /^\/v1\/responses\/([^/]+)$/.exec(path);
    if (responsesModel && request.method === "POST") {
      if (!gatewayOk) return gatewayDenied();
      let raw = "{}";
      try {
        raw = (await request.text()) || "{}";
      } catch {
        return jsonResponse({ error: { message: "invalid JSON body", type: "invalid_request_error" } }, 400);
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch (e) {
        return jsonResponse({ error: { message: `invalid JSON body: ${(e as Error).message}`, type: "invalid_request_error" } }, 400);
      }
      let model: string;
      try {
        model = decodeURIComponent(responsesModel[1]!);
      } catch {
        return jsonResponse({ error: { message: "invalid model id encoding", type: "invalid_request_error" } }, 400);
      }
      return handleCompletion({
        env: envWithBase(env),
        ctx,
        format: "responses",
        body,
        auth: { apiKey: auth.zenKey },
        modelOverride: model,
        sessionId: clientSessionId(request),
        signal: request.signal,
      });
    }

    return jsonResponse({ error: { message: `not found: ${request.method} ${path}`, type: "invalid_request_error" } }, 404);
  },
} satisfies ExportedHandler<WorkerEnv>;

function envWithBase(env: WorkerEnv): Record<string, unknown> {
  return env as unknown as Record<string, unknown>;
}

/**
 * The client's session id, if it sent one. `x-opencode-session` is accepted as
 * an alias because clients already configured for the opencode CLI send it, and
 * reusing the id keeps their turns in the same zen rate-limit bucket.
 */
function clientSessionId(request: Request): string | undefined {
  return request.headers.get("x-session-id") ?? request.headers.get("x-opencode-session") ?? undefined;
}

async function safeVersion(env: WorkerEnv, ctx: ExecutionContext): Promise<string> {
  try {
    return await getOpencodeVersion(env, ctx);
  } catch {
    return fallbackVersion(env);
  }
}

/** Constant-time string comparison to prevent timing attacks on the gateway key. */
function timingSafeEqual(a: string | null, b: string): boolean {
  if (a === null || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface ExtractedAuth {
  /** caller's zen api key, if provided */
  zenKey: string | null;
  /** gateway key as sent by the caller (for GATEWAY_KEY validation) */
  gatewayKey: string | null;
}

function extractAuth(url: URL, request: Request, env: WorkerEnv): ExtractedAuth {
  const authHeader = request.headers.get("authorization");
  let bearer: string | null = null;
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    bearer = authHeader.slice(7).trim() || null;
  }
  const apiKeyHeader = request.headers.get("x-api-key");
  const googKey = request.headers.get("x-goog-api-key");
  const zenKeyHeader = request.headers.get("x-zen-key");
  const gatewayHeader = request.headers.get("x-oc-gateway-key");
  const queryKey = url.searchParams.get("key");

  // "public" is the CLI's anonymous token, never a real key — drop it so a real
  // key in another header still wins
  const usable = (v: string | null): v is string => typeof v === "string" && v.length > 0 && v !== "public";
  const gatewayValue = env.GATEWAY_KEY;

  let gatewayKey: string | null = gatewayHeader;
  let bearerIsGateway = false;
  if (!gatewayKey && gatewayValue && bearer === gatewayValue) {
    gatewayKey = bearer;
    bearerIsGateway = true;
  }

  // when the bearer token was the gateway key it must not be used as a zen key
  const candidates = [bearerIsGateway ? null : bearer, apiKeyHeader, googKey, zenKeyHeader, queryKey].filter(usable);
  let zenKey: string | null = candidates[0] ?? null;

  // deployment-wide fallback: applies to anonymous callers and to callers who
  // authenticated with the gateway key but sent no zen key of their own
  if (!zenKey && env.DEFAULT_ZEN_KEY) {
    if (!gatewayValue || gatewayKey) zenKey = env.DEFAULT_ZEN_KEY;
  }

  return { zenKey, gatewayKey };
}

async function handleModels(env: WorkerEnv, mode: "list" | "detail", modelId?: string): Promise<Response> {
  const { models } = await fetchZenModels(env as unknown as Record<string, unknown>);

  if (mode === "detail") {
    const found = models.find((m) => m.id === modelId);
    if (!found) {
      return jsonResponse({ error: { message: `model '${modelId}' not found`, type: "invalid_request_error" } }, 404);
    }
    return jsonResponse({
      id: found.id,
      object: "model",
      created: found.created,
      owned_by: "opencode",
      meta: { endpoint: classifyModel(found.id) },
    });
  }

  return jsonResponse({
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: m.created,
      owned_by: "opencode",
      meta: {
        endpoint: classifyModel(m.id),
        native_format: classifyModel(m.id) === "anthropic" ? "anthropic_messages" : classifyModel(m.id) === "gemini" ? "gemini" : "openai",
      },
    })),
  });
}
