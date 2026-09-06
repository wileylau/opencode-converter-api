/**
 * Shared completion pipeline: parse inbound request → canonical → zen native body
 * → upstream call → (stream | json) → public format response.
 */

import type { CanonicalEvent, CanonicalRequest, CanonicalResponse } from "./canonical";
import { canonicalResponseFromEvents } from "./canonical";
import { parseChatCompletionsRequest, parseAnthropicRequest, parseResponsesRequest } from "./parse/requests";
import { buildZenRequestBody } from "./build/zen";
import { streamParserFor } from "./parse/streams";
import { createChatEmitter, createAnthropicEmitter, createResponsesEmitter } from "./build/streams";
import { canonicalToPublic, readUpstreamJson, zenErrorFromText, type PublicFormat } from "./build/responses";
import { callZen, pickEndpoint, classifyModel, fetchZenModels, ZenError, numEnv, zenBaseFromEnv, type ZenRequestOptions, type ZenCallContext } from "./zen";
import { mapperForRequest, remapCanonicalResponse, remapEvents, ToolNameMapper } from "./tools";
import {
  classifyFailure,
  emptyRetryDelay,
  isConnectivityFailure,
  isGeoBlockMessage,
  networkRetryDelay,
  retryPolicyFromEnv,
  sleep,
  statusRetryDelay,
} from "./retry";
import { isReasoningRejection, lowerEffort, planMaxEffort, type Effort } from "./reasoning";

/** tool_choice repair + one step per reasoning level */
const MAX_REPAIR_PASSES = 8;
import { jsonResponse, sseResponse, randomId } from "./util";

export type InboundFormat = PublicFormat;

export interface HandlerEnv {
  env: Record<string, unknown>;
  ctx?: { waitUntil(p: Promise<unknown>): void };
  /** inbound format */
  format: InboundFormat;
  /** raw JSON body */
  body: Record<string, unknown>;
  auth: { apiKey: string | null };
  /** upstream model override, e.g. from /responses model path routing */
  modelOverride?: string;
  /** client-provided stable session id, forwarded as x-opencode-session */
  sessionId?: string;
  /** client disconnect signal — aborts the upstream fetch when the client goes away */
  signal?: AbortSignal;
}

/**
 * Call zen with two independent retry budgets:
 *   - status retries  (429/502/503/529): the upstream is reachable but busy.
 *   - network retries (dropped connection, DNS/TLS failure, timeout): the
 *     internet went away, so reconnect patiently — up to 150 attempts over
 *     15 minutes by default (`UPSTREAM_NETWORK_RETRIES`,
 *     `UPSTREAM_NETWORK_DEADLINE_MS`).
 *
 * Retrying is always safe here: no byte has reached the client yet.
 */
async function callZenWithRetry(
  opts: ZenRequestOptions & ZenCallContext,
  env: Record<string, unknown>,
  budget?: ReconnectBudget,
): Promise<{ response: Response; version: string; attempts: number; reconnects: number; controller: AbortController }> {
  const policy = retryPolicyFromEnv(env);
  const startedAt = Date.now();
  const statusDeadline = startedAt + policy.statusDeadlineMs;
  const shared = budget ?? { used: 0 };

  let version = "";
  let statusAttempt = 0;
  let geoBlockPeeks = 0;

  for (;;) {
    statusAttempt += 1;
    let result: Awaited<ReturnType<typeof callZen>>;
    try {
      result = await callZen(opts);
    } catch (err) {
      const cls = classifyFailure(err, Boolean(opts.signal?.aborted));
      const zenErr = toZenError(err);

      // the caller is gone: nothing to retry for
      if (cls === "client_abort" || opts.signal?.aborted) throw zenErr;

      // the platform caps outbound subrequests per request; more retries are futile
      if (cls === "subrequest_limit") {
        throw new ZenError(
          503,
          "network_error",
          `lost connection to opencode zen and hit this platform's outbound request limit after ${shared.used} reconnect attempt(s). The network looks down — try again once it is back.`,
        );
      }

      if (isConnectivityFailure(cls)) {
        shared.used += 1;
        const outOfAttempts = shared.used >= policy.networkRetries;
        const outOfTime = Date.now() - startedAt >= policy.networkDeadlineMs;
        if (outOfAttempts || outOfTime) {
          throw new ZenError(
            zenErr.status,
            zenErr.upstreamType,
            `${zenErr.message} (gave up after ${shared.used} reconnect attempt(s) over ${Math.round((Date.now() - startedAt) / 1000)}s)`,
          );
        }
        await sleep(networkRetryDelay(shared.used, policy.networkDelayCapMs));
        statusAttempt -= 1; // a connectivity failure must not consume the status budget
        continue;
      }

      throw zenErr;
    }

    version = result.version;
    const { response } = result;
    const standardRetryable = response.status === 429 || response.status === 502 || response.status === 503 || response.status === 529;

    // Region blocks arrive as 401/403 (permanent-looking) but are usually
    // transient: zen's provider pool rotates nodes, and the same model works
    // seconds later. Peek at the body before deciding.
    const geoRetryable =
      (response.status === 401 || response.status === 403) &&
      geoBlockPeeks < policy.geoBlockRetries;
    let drained = "";
    if (geoRetryable || standardRetryable) {
      drained = await streamToTextSafe(response);
      if (geoRetryable && !isGeoBlockMessage(drained)) {
        // a genuine auth failure — hand it back untouched, no retries
        return { response, version, attempts: statusAttempt, reconnects: shared.used, controller: result.controller };
      }
    }

    if (geoRetryable && isGeoBlockMessage(drained)) {
      geoBlockPeeks += 1;
      const delayMs = 600 + Math.floor(Math.random() * 400);
      if (opts.signal?.aborted) {
        throw withGeoHint(zenErrorFromText(response.status, drained));
      }
      await sleep(delayMs);
      statusAttempt -= 1; // geo-block retries use their own budget, not the status one
      continue;
    }

    if (!standardRetryable || statusAttempt >= policy.statusRetries) {
      return { response, version, attempts: statusAttempt, reconnects: shared.used, controller: result.controller };
    }
    // capture the error body before retrying (a drained body can't be re-read)
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const delayMs = statusRetryDelay(statusAttempt, Number.isFinite(retryAfter) ? retryAfter : undefined);
    if (Date.now() + delayMs > statusDeadline || opts.signal?.aborted) {
      // out of budget: surface the last upstream error instead of stalling further
      throw zenErrorFromText(response.status, drained, retryAfterHeader);
    }
    await sleep(delayMs);
  }
}

/** Reconnect attempts shared between the initial call and any stream restarts. */
interface ReconnectBudget {
  used: number;
}

/**
 * Muse-class models occasionally stream the entire answer as reasoning and end
 * with an empty visible message; clients that drop reasoning parts (ZCode, most
 * OpenAI-SDK apps) then show nothing. Guard: if a response carries reasoning
 * but no visible text and no tool calls, promote the reasoning to text.
 */
export function promoteReasoningIfEmpty(c: CanonicalResponse): CanonicalResponse {
  const hasText = c.output.some((o) => o.type === "text" && o.text.trim());
  const hasTool = c.output.some((o) => o.type === "tool_call");
  if (hasText || hasTool) return c;
  const reasoning = c.output
    .filter((o): o is Extract<typeof o, { type: "reasoning" }> => o.type === "reasoning")
    .map((o) => o.text)
    .join("")
    .trim();
  if (!reasoning) return c;
  // replace the reasoning outputs: clients that render reasoning would otherwise
  // show the same content twice
  return { ...c, output: [{ type: "text", text: reasoning }] };
}

/** True when a response carries something a client can actually show or act on. */
export function hasUsableOutput(c: CanonicalResponse): boolean {
  return c.output.some(
    (o) => (o.type === "text" && o.text.trim().length > 0) || o.type === "tool_call" || (o.type === "reasoning" && o.text.trim().length > 0),
  );
}

/** Streaming counterpart: emits the buffered reasoning as text just before stop. */
export function makeEmptyStreamGuard(): (ev: CanonicalEvent) => CanonicalEvent[] {
  let reasoning = "";
  let sawVisible = false;
  let finished = false;
  return (ev: CanonicalEvent): CanonicalEvent[] => {
    if (finished) return [ev];
    switch (ev.type) {
      case "text_delta":
        if (ev.delta.trim()) sawVisible = true;
        return [ev];
      case "tool_call_start":
        sawVisible = true;
        return [ev];
      case "reasoning_delta":
        if (!sawVisible) reasoning += ev.delta;
        return [ev];
      case "stop": {
        finished = true;
        if (!sawVisible && reasoning.trim()) {
          return [{ type: "text_delta", delta: reasoning.trim() }, ev];
        }
        return [ev];
      }
      default:
        return [ev];
    }
  };
}

/** Convert fetch/abort failures into descriptive ZenErrors. */
function toZenError(err: unknown): ZenError {
  if (err instanceof ZenError) return err;
  const message = (err as Error)?.message ?? String(err);
  if (/TimeoutError|did not respond within/i.test(message)) {
    return new ZenError(504, "upstream_timeout", `opencode zen did not respond in time (${message}). It may be overloaded — try again, use a different model, or send your API key.`);
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return new ZenError(499, "client_closed", "request aborted by the client");
  }
  return new ZenError(502, "network_error", `could not reach opencode zen: ${message}`);
}

/** Tag region-block errors once, so every failure path explains the retries. */
function withGeoHint(err: ZenError): ZenError {
  if (isGeoBlockMessage(err.message ?? "") && !err.message.includes("usually intermittent")) {
    return new ZenError(
      err.status,
      err.upstreamType,
      `${err.message} — this block is usually intermittent (zen's provider pool rotates nodes) and the request was retried automatically. Try again, or pick a different model.`,
    );
  }
  return err;
}

/** Append actionable guidance to rate-limit style upstream errors. */
function humanizeUpstreamError(err: ZenError, attempts: number, reconnects = 0): string {
  if (isGeoBlockMessage(err.message ?? "")) {
    return withGeoHint(err).message;
  }
  const rateLimited =
    err.status === 429 || /rate.?limit|FreeUsageLimit/i.test(err.upstreamType) || /rate.?limit/i.test(err.message);
  if (!rateLimited) return err.message;
  const hint = err.message.includes("api key")
    ? ""
    : " Anonymous free-tier quota is shared and refills continuously — send your own zen API key (Authorization: Bearer <key>) for a dedicated quota, or retry shortly.";
  const retried = attempts > 1 ? ` (retried ${attempts - 1}×)` : "";
  const reconnected = reconnects > 0 ? ` (reconnected ${reconnects}×)` : "";
  return `${err.message}${hint}${retried}${reconnected}`;
}

function parseInbound(format: InboundFormat, body: Record<string, unknown>): CanonicalRequest {
  switch (format) {
    case "chat":
      return parseChatCompletionsRequest(body);
    case "messages":
      return parseAnthropicRequest(body);
    case "responses":
      return parseResponsesRequest(body);
  }
}

function publicError(format: InboundFormat, status: number, type: string, message: string, extraHeaders: Record<string, string> = {}): Response {
  switch (format) {
    case "chat":
      return jsonResponse(
        { error: { message, type, code: type } },
        status,
        extraHeaders,
      );
    case "messages":
      return jsonResponse({ type: "error", error: { type: mapAnthropicErrorType(type), message } }, status, extraHeaders);
    case "responses":
      return jsonResponse({ error: { code: type, message, param: null } }, status, extraHeaders);
  }
}

function mapAnthropicErrorType(type: string): string {
  if (type === "rate_limit_error" || type === "FreeUsageLimitError" || type === "rate_limit_exceeded") return "rate_limit_error";
  if (type === "AuthError" || type === "authentication_error") return "authentication_error";
  if (type === "ModelError" || type === "invalid_request_error") return "invalid_request_error";
  if (type === "overloaded_error") return "overloaded_error";
  return "api_error";
}

function statusForError(err: ZenError): number {
  if (err.status === 401 || err.status === 403) return err.status === 401 ? 401 : 403;
  if (err.status === 404) return 404;
  if (err.status === 429) return 429;
  if (err.status === 504) return 504;
  if (err.status >= 400 && err.status < 500) return 400;
  return 502;
}

/**
 * Build the model→family map used for routing. `trusted` is false when the list
 * is stale or the built-in fallback, in which case unknown model ids must be
 * forwarded to zen rather than rejected locally.
 */
async function liveFamilyMap(env: Record<string, unknown>): Promise<{ map: Map<string, string> | null; trusted: boolean }> {
  try {
    const { models, stale } = await fetchZenModels(env);
    const map = new Map<string, string>();
    for (const m of models) map.set(m.id, classifyModel(m.id));
    return { map: map.size ? map : null, trusted: !stale && map.size > 0 };
  } catch {
    return { map: null, trusted: false };
  }
}

export async function handleCompletion(h: HandlerEnv): Promise<Response> {
  const started = Date.now();
  let req: CanonicalRequest;
  try {
    req = parseInbound(h.format, h.body);
  } catch (e) {
    return publicError(h.format, 400, "invalid_request_error", `failed to parse request: ${(e as Error).message}`);
  }
  if (h.modelOverride) req.model = h.modelOverride;
  if (!req.model) {
    return publicError(h.format, 400, "invalid_request_error", "model is required");
  }

  const { map: families, trusted: familiesTrusted } = await liveFamilyMap(h.env);
  if (families && familiesTrusted && !families.has(req.model)) {
    return publicError(
      h.format,
      404,
      "model_not_found",
      `model '${req.model}' is not available on opencode zen. Available models: ${families.size} (GET /v1/models)`,
    );
  }

  const wantsStream = req.stream;
  const target = pickEndpoint(req.model, families, wantsStream, zenBaseFromEnv(h.env));

  // Always run the model at the highest reasoning level it supports; an
  // unsupported level is corrected by the repair chain on the first 400.
  if (String(h.env.FORCE_MAX_REASONING ?? "1") !== "0") {
    const plan = planMaxEffort(req.model);
    req = { ...req, reasoningEffort: plan.effort };
  }

  const toolMapper: ToolNameMapper = mapperForRequest(req);

  try {
    let effectiveReq: CanonicalRequest = req;
    let bodyStr = JSON.stringify(buildZenRequestBody(target.endpoint, effectiveReq, wantsStream, toolMapper));

    // Repair pass: some zen model families reject specific mapped params (e.g.
    // muse rejects forced tool_choice). On a recognizable 400, rebuild once.
    for (let pass = 0; ; pass++) {
      const reconnectBudget: ReconnectBudget = { used: 0 };
      /** attempts spent because the model answered with nothing usable */
      const emptyBudget: ReconnectBudget = { used: 0 };
      const zenCallOptions = {
        auth: { apiKey: h.auth.apiKey, anonymous: !h.auth.apiKey },
        body: bodyStr,
        target,
        stream: wantsStream,
        env: h.env,
        ctx: h.ctx,
        sessionId: h.sessionId,
        signal: h.signal,
      };
      const firstCall = await callZenWithRetry(zenCallOptions, h.env, reconnectBudget);
      const { version, attempts } = firstCall;
      let response = firstCall.response;
      let upstreamController = firstCall.controller;

      /**
       * Give the model more room before retrying an empty answer: reasoning-heavy
       * models can spend the whole budget thinking and return nothing visible.
       */
      const escalateTokenBudget = (): boolean => {
        const current = effectiveReq.maxTokens;
        if (!current || current >= 200_000) return false;
        effectiveReq = { ...effectiveReq, maxTokens: Math.min(200_000, Math.max(2_048, current * 2)) };
        zenCallOptions.body = JSON.stringify(buildZenRequestBody(target.endpoint, effectiveReq, wantsStream, toolMapper));
        return true;
      };

    // Upstream error: nothing has been sent downstream yet, so normalize to a
    // clean error response regardless of whether the client asked for a stream.
    if (!response.ok) {
      const text = await streamToTextSafe(response);
      const zenErr = zenErrorFromText(response.status, text, response.headers.get("retry-after"));
      const repaired = pass < MAX_REPAIR_PASSES ? repairRequest(effectiveReq, zenErr) : null;
      if (repaired) {
        effectiveReq = repaired;
        bodyStr = JSON.stringify(buildZenRequestBody(target.endpoint, effectiveReq, wantsStream, toolMapper));
        continue;
      }
      const headers: Record<string, string> = {
        "x-opencode-converter-version": version,
        "x-opencode-upstream": target.endpoint,
      };
      if (zenErr.retryAfter) headers["retry-after"] = String(zenErr.retryAfter);
      return publicError(
        h.format,
        statusForError(zenErr),
        zenErr.upstreamType,
        humanizeUpstreamError(zenErr, attempts, reconnectBudget.used),
        headers,
      );
    }

    if (!wantsStream) {
      // body deadline: a 200 that never finishes producing JSON must not hang forever
      const bodyTimeoutMs = numEnv(h.env, "UPSTREAM_BODY_TIMEOUT_MS", 240_000);
      const bodyTimer =
        bodyTimeoutMs > 0
          ? setTimeout(
              () => upstreamController.abort(new DOMException(`zen stopped responding after ${Math.max(1, Math.round(bodyTimeoutMs / 1000))}s`, "TimeoutError")),
              bodyTimeoutMs,
            )
          : undefined;
      const policy = retryPolicyFromEnv(h.env);
      const readBody = async (res: Response): Promise<CanonicalResponse> => {
        // Some upstreams answer a non-stream request with SSE anyway — fold the
        // event stream into a single response instead of failing to parse it.
        if ((res.headers.get("content-type") ?? "").includes("text/event-stream") && res.body) {
          const collected: CanonicalEvent[] = [];
          for await (const ev of streamParserFor(target.endpoint)(res.body)) collected.push(ev);
          return eventsToCanonical(collected, randomId("chatcmpl"), req.model);
        }
        return readUpstreamJson(target.endpoint, res, req.model);
      };
      let canonical: CanonicalResponse;
      try {
        // A drop while reading the body is safe to retry: nothing was sent yet.
        for (let bodyAttempt = 0; ; bodyAttempt++) {
          try {
            canonical = await readBody(bodyAttempt === 0 ? response : (await callZenWithRetry(zenCallOptions, h.env, reconnectBudget)).response);
            break;
          } catch (err) {
            const cls = classifyFailure(err, Boolean(h.signal?.aborted));
            if (!isConnectivityFailure(cls) || h.signal?.aborted || reconnectBudget.used >= policy.networkRetries) throw err;
            reconnectBudget.used += 1;
            await sleep(networkRetryDelay(reconnectBudget.used, policy.networkDelayCapMs));
          }
        }
      } catch (err) {
        if (bodyTimer) clearTimeout(bodyTimer);
        throw toZenError(err);
      }
      if (bodyTimer) clearTimeout(bodyTimer);
      canonical = promoteReasoningIfEmpty(remapCanonicalResponse(canonical, toolMapper));

      // The model can be perfectly healthy and still return nothing usable
      // (all tokens burned on internal thinking). Retry with a bigger budget.
      while (!hasUsableOutput(canonical) && emptyBudget.used < policy.emptyRetries && !h.signal?.aborted) {
        emptyBudget.used += 1;
        escalateTokenBudget();
        await sleep(emptyRetryDelay(emptyBudget.used));
        const retryCall = await callZenWithRetry(zenCallOptions, h.env, reconnectBudget);
        response = retryCall.response;
        upstreamController = retryCall.controller;
        if (!response.ok) break;
        try {
          canonical = promoteReasoningIfEmpty(remapCanonicalResponse(await readBody(response), toolMapper));
        } catch {
          break;
        }
      }

      const headers: Record<string, string> = {
        "x-opencode-converter-version": version,
        "x-opencode-upstream": target.endpoint,
        ...(reconnectBudget.used ? { "x-opencode-reconnects": String(reconnectBudget.used) } : {}),
        ...(emptyBudget.used ? { "x-opencode-empty-retries": String(emptyBudget.used) } : {}),
      };
      return jsonResponse(canonicalToPublic(h.format, canonical), 200, headers);
    }

    // streaming: parse upstream SSE → canonical events → public SSE
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body) {
      return publicError(h.format, 502, "upstream_error", "upstream returned empty stream");
    }

    const id =
      h.format === "chat" ? randomId("chatcmpl") : h.format === "messages" ? randomId("msg") : `resp_${randomId("r").slice(2)}`;

    // Upstream answered 200 with JSON instead of SSE (some upstreams do this for
    // stream=true) — parse it and re-emit as a proper event stream.
    if (contentType.includes("application/json")) {
      const canonical = promoteReasoningIfEmpty(remapCanonicalResponse(await readUpstreamJson(target.endpoint, response, req.model), toolMapper));
      const synth: CanonicalEvent[] = [{ type: "start", id, model: req.model }];
      for (const o of canonical.output) {
        if (o.type === "text") {
          if (o.text) synth.push({ type: "text_delta", delta: o.text });
        } else if (o.type === "reasoning") {
          if (o.text) synth.push({ type: "reasoning_delta", delta: o.text });
        } else if (o.type === "tool_call") {
          synth.push({ type: "tool_call_start", index: 0, id: o.id, name: o.name });
          synth.push({ type: "tool_call_delta", index: 0, argsDelta: o.argumentsJson || "{}" });
          synth.push({ type: "tool_call_end", index: 0 });
        }
      }
      if (canonical.usage) synth.push({ type: "usage", usage: canonical.usage, cost: canonical.cost });
      synth.push({ type: "stop", stopReason: canonical.stopReason });
      const emitJson =
        h.format === "chat"
          ? createChatEmitter({ model: req.model, id })
          : h.format === "messages"
            ? createAnthropicEmitter({ model: req.model, id })
            : createResponsesEmitter({ model: req.model, id });
      const chunks: Uint8Array[] = [];
      for (const ev of synth) chunks.push(...emitJson(ev));
      return sseResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
          },
        }),
        { "x-opencode-converter-version": version, "x-opencode-upstream": target.endpoint },
      );
    }

    const parse = streamParserFor(target.endpoint);
    const policy = retryPolicyFromEnv(h.env);
    const stallTimeoutMs = numEnv(h.env, "UPSTREAM_STALL_TIMEOUT_MS", 300_000);
    const streamDeadlineMs = numEnv(h.env, "STREAM_DEADLINE_MS", 570_000);
    const secs = (ms: number) => Math.max(1, Math.round(ms / 1000));

    let activeBody: ReadableStream<Uint8Array> = response.body;
    let activeController = upstreamController;
    const upstreamAbort = (reason: unknown) => activeController.abort(reason);

    // Emitter + empty-answer guard are recreated on a pre-first-byte restart so a
    // reconnect can't replay half a message.
    const makeEmitter = () =>
      h.format === "chat"
        ? createChatEmitter({ model: req.model, id })
        : h.format === "messages"
          ? createAnthropicEmitter({ model: req.model, id })
          : createResponsesEmitter({ model: req.model, id });
    let emit = makeEmitter();
    let emptyGuard = makeEmptyStreamGuard();

    /** true once any byte reached the client — after that a restart would duplicate output */
    let enqueuedAny = false;

    /** set by the stall watchdog to force a restart that isn't a real disconnect */
    let stallRestart = false;
    /** anything visible (text / tool call / reasoning) seen on the current attempt */
    let sawUsable = false;

    /** Reopen the upstream request and reset per-attempt state. Nothing has been sent. */
    const reopenUpstream = async (): Promise<void> => {
      const reopened = await callZenWithRetry(zenCallOptions, h.env, reconnectBudget);
      if (!reopened.response.ok || !reopened.response.body) {
        const text = await streamToTextSafe(reopened.response);
        throw zenErrorFromText(reopened.response.status, text, reopened.response.headers.get("retry-after"));
      }
      activeBody = reopened.response.body;
      activeController = reopened.controller;
      emit = makeEmitter();
      emptyGuard = makeEmptyStreamGuard();
      sawUsable = false;
    };

    /**
     * Raw upstream events, with two kinds of transparent restart — both only
     * possible while the client has received nothing, so nothing is ever replayed:
     *   1. the connection dropped (counts against the reconnect budget)
     *   2. the model produced no usable output, or went silent long enough for the
     *      stall watchdog to fire (counts against the empty-answer budget)
     */
    const source: AsyncGenerator<CanonicalEvent> = (async function* () {
      for (;;) {
        try {
          for await (const ev of remapEvents(parse(activeBody), toolMapper)) {
            if (ev.type === "text_delta" || ev.type === "tool_call_start" || ev.type === "reasoning_delta") sawUsable = true;
            yield ev;
          }
        } catch (err) {
          const cls = classifyFailure(err, Boolean(h.signal?.aborted));
          if (stallRestart) {
            // the watchdog aborted this attempt on purpose
            stallRestart = false;
            await sleep(emptyRetryDelay(emptyBudget.used));
            escalateTokenBudget();
            await reopenUpstream();
            continue;
          }
          const canRestart =
            isConnectivityFailure(cls) &&
            !enqueuedAny &&
            !h.signal?.aborted &&
            reconnectBudget.used < policy.networkRetries;
          if (!canRestart) throw err;

          reconnectBudget.used += 1;
          await sleep(networkRetryDelay(reconnectBudget.used, policy.networkDelayCapMs));
          await reopenUpstream();
          continue;
        }

        // upstream finished. If it produced nothing the client could use and we
        // have not sent a byte yet, roll the dice again with a bigger budget.
        const retryEmpty =
          !sawUsable && !enqueuedAny && !h.signal?.aborted && emptyBudget.used < policy.emptyRetries;
        if (!retryEmpty) return;
        emptyBudget.used += 1;
        escalateTokenBudget();
        await sleep(emptyRetryDelay(emptyBudget.used));
        await reopenUpstream();
      }
    })();

    let streamEnded = false;
    const releaseUpstream = () => {
      void source.return(undefined as never).catch(() => {});
    };
    /** Terminate the client stream once. `synthesizeStop` emits a stop the upstream never sent. */
    const finishStream = (dst: ReadableStreamDefaultController<Uint8Array>, synthesizeStop: boolean): void => {
      if (streamEnded) return;
      streamEnded = true;
      if (synthesizeStop) {
        // route through the guard so a reasoning-only answer still yields text
        for (const guarded of emptyGuard({ type: "stop", stopReason: "end" })) {
          for (const e of emit(guarded)) dst.enqueue(e);
        }
      }
      releaseUpstream();
      dst.close();
    };

    // pull() is called whenever the consumer wants more data. It returns only
    // after enqueueing at least one chunk (or terminating), because a pull that
    // enqueues nothing is not guaranteed to be retried by the runtime.
    /** in-flight source.next(), kept across pulls so a stall never orphans it */
    let pendingNext: Promise<IteratorResult<CanonicalEvent>> | null = null;

    const output = new ReadableStream<Uint8Array>({
      async pull(dst) {
        try {
          for (;;) {
            const nextPromise = pendingNext ?? source.next();
            pendingNext = nextPromise;
            // the loser of the race must never reject unobserved
            nextPromise.catch(() => {});
            let stallTimer: ReturnType<typeof setTimeout> | undefined;
            let result: IteratorResult<CanonicalEvent> | null;
            try {
              if (stallTimeoutMs > 0) {
                const stallPromise = new Promise<null>((resolve) => {
                  stallTimer = setTimeout(() => resolve(null), stallTimeoutMs);
                });
                result = await Promise.race([nextPromise, stallPromise]);
              } else {
                result = await nextPromise;
              }
            } finally {
              if (stallTimer) clearTimeout(stallTimer);
            }
            // the pending promise is only settled when the event won the race
            if (result !== null) pendingNext = null;

            if (result === null) {
              // Silent upstream. While the client has received nothing we can
              // simply start the attempt over (models that think for a long time
              // internally look identical to a hang from out here).
              if (!enqueuedAny && emptyBudget.used < policy.emptyRetries && !h.signal?.aborted) {
                emptyBudget.used += 1;
                stallRestart = true;
                upstreamAbort(new DOMException(`no output for ${secs(stallTimeoutMs)}s — restarting attempt`, "TimeoutError"));
                continue;
              }
              upstreamAbort(new DOMException(`zen sent nothing for ${secs(stallTimeoutMs)}s`, "TimeoutError"));
              for (const e of emit({
                type: "error",
                error: {
                  type: "upstream_stalled",
                  message: `opencode zen stopped sending data for ${secs(stallTimeoutMs)}s (after ${emptyBudget.used} restart attempt(s)) — stream aborted. Try again or use a different model.`,
                },
              }))
                dst.enqueue(e);
              finishStream(dst, false);
              return;
            }

            if (result.done) {
              // upstream ended without a stop event — synthesize one
              finishStream(dst, true);
              return;
            }

            let terminal = false;
            let enqueuedNow = 0;
            for (const event of emptyGuard(result.value)) {
              for (const e of emit(event)) {
                dst.enqueue(e);
                enqueuedNow += 1;
                enqueuedAny = true;
              }
              if (event.type === "error" || event.type === "stop") terminal = true;
            }

            if (terminal) {
              finishStream(dst, false);
              return;
            }
            if (streamDeadlineMs > 0 && Date.now() - started > streamDeadlineMs) {
              // close gracefully before platform limits cut the response off
              finishStream(dst, true);
              return;
            }
            // only yield control once the consumer actually received bytes
            if (enqueuedNow > 0) return;
          }
        } catch (err) {
          const cls = classifyFailure(err, Boolean(h.signal?.aborted));
          const message = isConnectivityFailure(cls)
            ? `the connection to opencode zen dropped mid-answer after ${reconnectBudget.used} reconnect attempt(s) — the partial reply above is all that arrived. Send the request again.`
            : ((err as Error).message ?? "stream failed");
          try {
            for (const e of emit({
              type: "error",
              error: { type: isConnectivityFailure(cls) ? "network_error" : "stream_error", message },
            }))
              dst.enqueue(e);
          } catch {
            /* emitter may have ended */
          }
          releaseUpstream();
          try {
            if (!streamEnded) {
              streamEnded = true;
              dst.close();
            }
          } catch {
            /* already closed */
          }
        }
      },
      cancel() {
        streamEnded = true;
        upstreamAbort(new DOMException("client disconnected", "AbortError"));
        releaseUpstream();
      },
    });

    const headers: Record<string, string> = {
      "x-opencode-converter-version": version,
      "x-opencode-upstream": target.endpoint,
      ...(reconnectBudget.used ? { "x-opencode-reconnects": String(reconnectBudget.used) } : {}),
    };
    return sseResponse(output, headers);
    }
  } catch (err) {
    if (err instanceof ZenError) {
      return publicError(h.format, statusForError(err), err.upstreamType, err.message);
    }
    return publicError(h.format, 502, "upstream_error", (err as Error).message ?? "unknown error");
  }
}

/**
 * Attempt to repair a request the upstream rejected with a 400.
 * Returns a patched copy of the request, or null if unrepairable.
 * Known upstream constraints (probed 2026-09-04):
 *   - muse (Meta upstream) rejects tool_choice other than "auto".
 */
/**
 * Rebuild a request the upstream rejected with a 400.
 * Known constraints: muse-class models accept only `tool_choice: "auto"`, and
 * reasoning levels differ per model — an unsupported effort steps down the chain
 * (max → xhigh → high → medium → low → minimal → none → dropped).
 */
function repairRequest(req: CanonicalRequest, err: ZenError): CanonicalRequest | null {
  const msg = err.message ?? "";
  if (err.status !== 400) return null;
  if (isReasoningRejection(msg) && req.reasoningEffort) {
    const next = lowerEffort(req.reasoningEffort as Effort);
    return { ...req, reasoningEffort: next };
  }
  if (/tool_choice/i.test(msg) && req.toolChoice !== "auto") {
    return { ...req, toolChoice: "auto" };
  }
  return null;
}

async function streamToTextSafe(response: Response): Promise<string> {
  try {
    if (!response.body) return "";
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return "";
  }
}

/** Build a canonical response from collected events (used by tests and by non-SSE fallback). */
export function eventsToCanonical(events: CanonicalEvent[], id: string, model: string, created?: number): CanonicalResponse {
  return canonicalResponseFromEvents(events, id, model, created ?? Math.floor(Date.now() / 1000));
}

