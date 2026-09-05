/**
 * Shared low-level utilities: JSON responses, CORS, SSE helpers, ids, data-URI parsing.
 */

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, x-api-key, x-goog-api-key, x-zen-key, anthropic-version, anthropic-beta, anthropic-dangerous-direct-browser-access, openai-beta, openai-organization, x-opencode-client, x-session-id, x-oc-version, x-oc-gateway-key, x-stainless-os, x-stainless-lang, x-stainless-arch, x-stainless-runtime, x-stainless-runtime-version, x-stainless-package-version, x-stainless-retry-count, x-stainless-timeout, x-stainless-helper-method, user-agent",
  "Access-Control-Expose-Headers":
    "x-opencode-converter-version, x-opencode-upstream, x-request-id, retry-after",
  "Access-Control-Max-Age": "86400",
};

/** Reflect whatever headers the client asks for; SDKs send many vendor-specific ones. */
export function corsPreflight(request?: Request): Response {
  const requested = request?.headers.get("access-control-request-headers");
  const headers = requested
    ? { ...CORS_HEADERS, "Access-Control-Allow-Headers": requested }
    : CORS_HEADERS;
  return new Response(null, { status: 204, headers });
}

export function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS, ...extra },
  });
}

export function sseResponse(stream: ReadableStream<Uint8Array>, extra: Record<string, string> = {}): Response {
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      ...CORS_HEADERS,
      ...extra,
    },
  });
}

export const TEXT_ENCODER = new TextEncoder();

export function randomId(prefix: string): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(12)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

/** A uuid that stays stable for the lifetime of the isolate (used as x-opencode-project). */
let cachedProjectId: string | undefined;
export function stableProjectId(): string {
  if (!cachedProjectId) cachedProjectId = crypto.randomUUID();
  return cachedProjectId;
}

export interface DataUrl {
  mimeType: string;
  base64: string;
  isBase64: boolean;
}

export function parseDataUrl(s: string): DataUrl | null {
  const m = /^data:([^;,]*?)?(;base64)?,([\s\S]*)$/i.exec(s);
  if (!m) return null;
  return {
    mimeType: m[1] || "text/plain",
    isBase64: Boolean(m[2]),
    base64: m[3] ?? "",
  };
}

/** Guess a mime type from a URL's extension (for http(s) media references). */
export function mimeFromUrl(url: string, fallback: string): string {
  const m = /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.exec(url);
  if (m) {
    const ext = m[1]!.toLowerCase();
    const map: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      svg: "image/svg+xml",
    };
    return map[ext] ?? fallback;
  }
  const a = /\.(mp3|wav|m4a|aac|ogg|flac)(\?|$)/i.exec(url);
  if (a) {
    const map: Record<string, string> = {
      mp3: "audio/mpeg",
      wav: "audio/wav",
      m4a: "audio/mp4",
      aac: "audio/aac",
      ogg: "audio/ogg",
      flac: "audio/flac",
    };
    return map[a[1]!.toLowerCase()] ?? fallback;
  }
  const v = /\.(mp4|webm|mov|mkv|avi)(\?|$)/i.exec(url);
  if (v) {
    const map: Record<string, string> = {
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      mkv: "video/x-matroska",
      avi: "video/x-msvideo",
    };
    return map[v[1]!.toLowerCase()] ?? fallback;
  }
  if (/\.pdf(\?|$)/i.test(url)) return "application/pdf";
  return fallback;
}

/** Collect a ReadableStream<Uint8Array> into a string (utf-8). Own decoder: safe under concurrency. */
export async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return decoder.decode(out);
}
