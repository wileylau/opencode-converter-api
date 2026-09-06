/**
 * Connectivity resilience: classification + backoff for upstream failures.
 *
 * Two budgets, deliberately separate:
 *   - status retries  (429 / 502 / 503 / 529)  — the upstream is reachable but
 *     busy; a handful of attempts on a short deadline is right.
 *   - network retries (connection dropped, DNS failure, TLS reset, timeout) —
 *     the *network* is gone. Those are worth a long, patient reconnect loop:
 *     up to UPSTREAM_NETWORK_RETRIES (default 150) attempts over
 *     UPSTREAM_NETWORK_DEADLINE_MS (default 15 min).
 */

export type FailureClass = "network" | "timeout" | "client_abort" | "subrequest_limit" | "other";

const NETWORK_MESSAGE = /(network connection lost|connection (reset|refused|closed|error)|failed to fetch|fetch failed|socket hang up|econnreset|econnrefused|econnaborted|epipe|enetunreach|enetdown|ehostunreach|etimedout|dns|getaddrinfo|name not resolved|could not be resolved|tls|ssl|handshake|premature close|other side closed|stream closed|internal error while|proxy request failed|connection attempt failed)/i;

const SUBREQUEST_MESSAGE = /too many subrequests|subrequest limit/i;

/**
 * Region-block messages arrive with 401/403 (which look permanent) but are
 * frequently transient: the same session works seconds later because zen's
 * provider pool rotates nodes. Worth retrying a few times before giving up.
 */
const GEO_BLOCK_MESSAGE = /(not available in your country|not available in your region|geo[- ]?block|region[- ]?block|country|embargo|sanction|unavailable in your)/i;

export function isGeoBlockMessage(message: string): boolean {
  return GEO_BLOCK_MESSAGE.test(message);
}

/** Classify a thrown fetch/abort error so the caller knows which budget applies. */
export function classifyFailure(err: unknown, clientAborted = false): FailureClass {
  const message = ((err as Error)?.message ?? String(err ?? "")).toLowerCase();
  const name = (err as Error)?.name ?? "";

  if (SUBREQUEST_MESSAGE.test(message)) return "subrequest_limit";
  if (name === "TimeoutError" || /did not respond within|stopped responding after|sent nothing for|headers timeout/i.test(message)) {
    return "timeout";
  }
  // A client-initiated abort is the only AbortError we must never retry.
  if (name === "AbortError" || /aborted|abort(ed)? by the client/i.test(message)) {
    return clientAborted ? "client_abort" : "network";
  }
  if (NETWORK_MESSAGE.test(message)) return "network";
  // Workers surfaces most connectivity problems as a bare TypeError from fetch
  if (name === "TypeError" && /fetch/i.test(message)) return "network";
  return "other";
}

/** True when the failure means "the connection dropped", i.e. worth reconnecting. */
export function isConnectivityFailure(cls: FailureClass): boolean {
  return cls === "network" || cls === "timeout";
}

/**
 * Reconnect backoff: fast for the first few attempts (a Wi-Fi blip clears in
 * seconds), then a steady poll so a 150-attempt budget spans minutes rather
 * than hours. Jittered to avoid lockstep retries across concurrent requests.
 */
export function networkRetryDelay(attempt: number, capMs = 5_000): number {
  const base = attempt <= 1 ? 250 : attempt === 2 ? 500 : attempt === 3 ? 1_000 : attempt === 4 ? 2_000 : capMs;
  const jitter = Math.floor(Math.random() * Math.min(400, base));
  return Math.min(base + jitter, capMs + 400);
}

/** Backoff for a reachable-but-busy upstream (429/5xx), honoring Retry-After. */
export function statusRetryDelay(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return Math.min(retryAfterSeconds * 1000, 30_000);
  }
  return Math.min(1200 * 2 ** Math.max(0, attempt - 1) + Math.floor(Math.random() * 400), 9_000);
}

export interface RetryPolicy {
  /** attempts for reachable-but-busy upstreams */
  statusRetries: number;
  /** attempts for connectivity failures (dropped internet) */
  networkRetries: number;
  /** attempts when the model is connected but returns nothing usable */
  emptyRetries: number;
  /** attempts for intermittent region blocks behind 401/403 */
  geoBlockRetries: number;
  /** wall-clock ceiling for the status-retry sequence */
  statusDeadlineMs: number;
  /** wall-clock ceiling for the reconnect sequence */
  networkDeadlineMs: number;
  /** per-attempt delay cap while reconnecting */
  networkDelayCapMs: number;
}

function intEnv(env: Record<string, unknown> | undefined, key: string, fallback: number, min: number, max: number): number {
  const raw = env?.[key];
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function retryPolicyFromEnv(env: Record<string, unknown> | undefined): RetryPolicy {
  return {
    statusRetries: intEnv(env, "UPSTREAM_RETRIES", 3, 1, 20),
    networkRetries: intEnv(env, "UPSTREAM_NETWORK_RETRIES", 150, 1, 1000),
    emptyRetries: intEnv(env, "UPSTREAM_EMPTY_RETRIES", 30, 0, 200),
    geoBlockRetries: intEnv(env, "UPSTREAM_GEOBLOCK_RETRIES", 4, 0, 20),
    statusDeadlineMs: intEnv(env, "UPSTREAM_TOTAL_DEADLINE_MS", 90_000, 1_000, 3_600_000),
    networkDeadlineMs: intEnv(env, "UPSTREAM_NETWORK_DEADLINE_MS", 900_000, 1_000, 3_600_000),
    networkDelayCapMs: intEnv(env, "UPSTREAM_NETWORK_DELAY_CAP_MS", 5_000, 100, 60_000),
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Backoff between retries of an empty answer. Short — the model is reachable and
 * the point is to give it another roll of the dice, not to wait out an outage.
 */
export function emptyRetryDelay(attempt: number): number {
  return Math.min(400 * attempt, 3_000) + Math.floor(Math.random() * 250);
}
