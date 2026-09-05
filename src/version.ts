/**
 * Auto-updating opencode CLI version.
 *
 * The converter presents itself to opencode zen exactly like the opencode CLI:
 * `User-Agent: opencode/<version>`. The version must track the latest released
 * CLI so the gateway never flags stale clients.
 *
 * Resolution order (each layer cached ~1h, stale value kept on failure):
 *   1. in-memory (per isolate)
 *   2. Cloudflare edge cache (caches.default)
 *   3. npm registry  https://registry.npmjs.org/opencode-ai/latest  → .version
 *   4. GitHub API    https://api.github.com/repos/anomalyco/opencode/releases/latest → .tag_name
 *   5. UPSTREAM fallback: env.FALLBACK_VERSION, then built-in constant
 */

const FALLBACK_VERSION = "1.18.27";
const TTL_MS = 60 * 60 * 1000; // refresh hourly

let memory: { version: string; fetchedAt: number } | null = null;

interface EnvLike {
  FALLBACK_VERSION?: string;
}

async function fetchFromNpm(): Promise<string | null> {
  try {
    const res = await fetch("https://registry.npmjs.org/opencode-ai/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    const v = data.version?.trim();
    return v && /^\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

async function fetchFromGithub(): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/repos/anomalyco/opencode/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "opencode-converter-api" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { tag_name?: string };
    const v = data.tag_name?.trim().replace(/^v/, "");
    return v && /^\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

async function resolveFresh(env: EnvLike): Promise<string> {
  // Both lookups fail closed (null) on a dead network; the caller then keeps the
  // last known good version, so an outage never blocks a completion request.
  const npm = await fetchFromNpm();
  if (npm) return npm;
  const gh = await fetchFromGithub();
  if (gh) return gh;
  return memory?.version || env.FALLBACK_VERSION?.trim() || FALLBACK_VERSION;
}

interface CachedEntry {
  version: string;
  fetchedAt: number;
}

/**
 * Returns the latest opencode CLI version, refreshing at most once per hour.
 * Never throws: on total failure it returns the last known good or built-in fallback.
 */
export async function getOpencodeVersion(env: EnvLike, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<string> {
  const now = Date.now();
  if (memory && now - memory.fetchedAt < TTL_MS) return memory.version;

  // Try the edge cache first to avoid stampedes across isolates.
  try {
    const cache = caches.default;
    const hit = await cache.match("https://cache.local/opencode-version");
    if (hit) {
      const entry = (await hit.json()) as CachedEntry | null;
      if (entry?.version && now - entry.fetchedAt < TTL_MS) {
        memory = entry;
        return entry.version;
      }
    }
  } catch {
    /* cache unavailable — continue */
  }

  const versionPromise = resolveFresh(env).then((version) => {
    memory = { version, fetchedAt: Date.now() };
    // Best-effort edge cache write for other isolates.
    try {
      const res = new Response(JSON.stringify(memory), {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
      });
      ctx?.waitUntil(caches.default.put("https://cache.local/opencode-version", res));
    } catch {
      /* ignore */
    }
    return version;
  });

  // Await directly: request handlers should carry the refresh cost once per hour,
  // but never fail because of it.
  try {
    return await versionPromise;
  } catch {
    return memory?.version ?? env.FALLBACK_VERSION?.trim() ?? FALLBACK_VERSION;
  }
}

/** Force a synchronous fallback without network (used for error paths / cold failures). */
export function fallbackVersion(env: EnvLike): string {
  return env.FALLBACK_VERSION?.trim() || memory?.version || FALLBACK_VERSION;
}
