# opencode-converter-api

A Cloudflare Worker that puts [opencode zen](https://opencode.ai/docs/zen/) behind standard, self-hostable API surfaces:

- **`POST /v1/chat/completions`** — OpenAI Chat Completions compatible
- **`POST /v1/messages`** — Anthropic Messages compatible
- **`POST /v1/responses`** — OpenAI Responses compatible
- **`GET /v1/models`**, **`GET /v1/models/{id}`** — live model list straight from zen

Every format supports **streaming (SSE)**, **tool calling** (full agentic loops), and **multimodal input**: images, audio, video, and PDFs (capability permitting per model). Bring **your own zen API key** — the worker stores nothing and proxies nothing but your request.

```
any OpenAI / Anthropic / Responses client
            │  (your key or none)
            ▼
   opencode-converter-api (this worker)
            │  presents as opencode CLI
            ▼
      opencode.ai/zen/v1
```

## How it works

Zen natively exposes four different API dialects, locked per model family:

| Model family | Zen endpoint | Zen dialect |
|---|---|---|
| `gpt-*`, `grok-*`, `muse-*` | `/zen/v1/responses` | OpenAI Responses |
| `claude-*`, `qwen*` | `/zen/v1/messages` | Anthropic Messages |
| `glm-*`, `kimi-*`, `minimax-*`, `deepseek-*`, `big-pickle`, `*free` (most) | `/zen/v1/chat/completions` | OpenAI Chat |
| `gemini-*` | `/zen/v1/models/{model}:generateContent` | Gemini |

Hitting the wrong endpoint for a model fails, so this worker routes every request to the right native dialect after a single canonical conversion:

```
inbound format ──parse──▶ canonical request ──build──▶ zen native dialect
                                                       (auto-routed per model)
inbound format ◀─emit─── canonical events/resp ◀─parse── zen SSE / JSON
```

### CLI identity (the important bit)

Zen's free tier only serves clients that look like the opencode CLI — verified experimentally: without the CLI `User-Agent`, free models return `429 FreeUsageLimitError`. This worker sends exactly what the real CLI sends (source: `packages/opencode/src/session/llm/request.ts` in `anomalyco/opencode`):

```
User-Agent: opencode/<version>
Authorization: Bearer <your-key | "public">
x-opencode-client: cli
x-opencode-session / x-opencode-request / x-opencode-project: <ids>
```

The version is **fetched live** from the npm registry (`opencode-ai/latest`) with a GitHub releases fallback, cached for one hour at the edge — so it tracks the latest CLI release with zero maintenance. Pin it via the `FALLBACK_VERSION` var if you ever need to.

### Authentication model

Your zen key **never touches this worker's config** — it travels client → worker → zen inside the request itself:

```bash
# any of these carry your zen key
Authorization: Bearer <zen-key>
x-api-key: <zen-key>
x-goog-api-key: <zen-key>
?key=<zen-key>            # query param, Gemini-SDK style
```

- **No key at all** → anonymous free-tier access (`Bearer public`, exactly like the CLI when logged out). Free models work; paid models return zen's auth error.
- **Optional `GATEWAY_KEY` secret** → require callers to also send `x-oc-gateway-key: <gateway-key>` (or use it as the bearer) to protect your deployment from strangers; the zen key then comes from `x-zen-key`/`x-api-key`/`?key=`.
- **Optional `DEFAULT_ZEN_KEY` secret** → a deployment-wide fallback zen key used when a caller sends none.

## Deploy

```bash
npm install
npx wrangler login
npm run deploy          # uses wrangler.toml
```

Optional secrets:

```bash
npx wrangler secret put GATEWAY_KEY      # gate your deployment
npx wrangler secret put DEFAULT_ZEN_KEY  # deployment-wide zen key
```

Local dev: `npm run dev` (worker on `http://localhost:8787`).

## Usage

```bash
# OpenAI style (free model, anonymous)
curl http://localhost:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"hi"}],"stream":true}'

# Anthropic style (your key, paid model)
curl https://<your-worker>.workers.dev/v1/messages \
  -H 'x-api-key: <zen-key>' -H 'Content-Type: application/json' \
  -d '{"model":"claude-haiku-4-5","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'

# OpenAI Responses style
curl https://<your-worker>.workers.dev/v1/responses \
  -H 'Authorization: Bearer <zen-key>' -H 'Content-Type: application/json' \
  -d '{"model":"gpt-5.6-luna","input":"hi"}'

# Multimodal (image on a vision-capable model, e.g. any muse-*/gemini-*/claude-*/gpt-*)
curl http://localhost:8787/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"muse-spark-1.2-contributor-free","messages":[{"role":"user","content":[
        {"type":"text","text":"what is this?"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}]}'
```

Tools, `stream`, `stop`, `temperature`, `top_p`, `max_tokens` / `max_output_tokens`, `reasoning_effort` / `thinking.budget_tokens`, and JSON-schema response formats are translated across all three formats.

### Multimodal support matrix

| Inbound part | Translated as |
|---|---|
| `image_url` / `input_image` / anthropic `image` | native image for the target dialect (base64 or URL) |
| `input_audio` (wav/mp3/mp4) | `input_audio` for openai dialects; inline audio for gemini; text notice on anthropic-only models |
| `input_file` (video/*) | `input_file` data-URI on responses dialect, inline data on gemini |
| `input_file`/`document` (pdf) | anthropic `document`, responses `input_file`, gemini inline |

If a target model can't accept a modality (zen is authoritative here), the request is passed through as-is and zen's own error is surfaced in your request's format.

## Rate limits & free-tier behavior

The anonymous free tier (no key) shares one quota pool, and zen throttles aggressively — **especially from datacenter IPs like Cloudflare Workers' egress ranges**. In practice, anonymous access through a deployed worker is unreliable (429 `FreeUsageLimitError` most of the time); from a residential IP it works until the local pool drains. **Treat BYOK as the primary usage mode**: send any zen API key (free to create) and you get a dedicated, reliable quota plus paid-model access. The worker mitigates residual rate limits for you:

- **Automatic retries** with exponential backoff on upstream 429/502/503 (default 3 attempts, tune with the `UPSTREAM_RETRIES` var, max 6) — retried only before any byte reaches your client, so streaming stays correct.
- **Actionable errors**: when the pool is drained the error message says so and suggests sending your own key.
- **Stable sessions**: send `x-session-id: <some-stable-id>` to group your requests under one zen session (mirrors how the CLI behaves) instead of a fresh session id per request.

For real work, send **your own zen API key** (any of the auth headers above) — you then have a dedicated quota and access to paid models. Free models work with a key too.

## Client compatibility fixes

Agent clients send payloads that zen's upstreams reject outright. The converter normalizes them transparently:

- **Long tool names** — upstreams cap function names at 64 chars (`^[a-zA-Z0-9_-]{1,64}$`), but MCP-style names like `zcode__mcp__filesystem__read_file_contents_with_line_numbers_and_ranges` (71 chars) are common. Such names are rewritten to short deterministic aliases (`t_<hash>`) on the way out — consistently across tool definitions, conversation history, and forced `tool_choice` — and mapped back to your original names in every response and stream event. Your client never sees the alias.
- **Unknown parameters** — client params the converter doesn't explicitly map (`logprobs`, `n`, `store`, …) are dropped rather than forwarded; zen 400s on unknown fields.
- **Per-family constraints** — when an upstream rejects a mapped param (e.g. Meta's muse models accept only `tool_choice: "auto"`), the request is rebuilt once without it and retried automatically instead of failing.
- **Empty-answer recovery** — muse-class models sometimes stream the entire answer as *reasoning* and end with an empty visible message; clients that hide reasoning then show nothing. The converter also captures text that upstreams deliver only in `done`/`completed` events (skipping normal deltas), and if a response would arrive with reasoning but no visible text and no tool calls, the reasoning content is promoted to a normal text reply.

## Maximum reasoning, always

Every request runs the model at the **highest reasoning level it supports**, descending only if the upstream rejects it:

```
max → xhigh → high → medium → low → minimal → none → (no reasoning params)
```

The starting level comes from a built-in table of what each zen model advertises (`gpt-5.6-*` and `claude-opus-5` → `max`, `muse-spark-*` → `xhigh`, `gemini-*` → `high`, and so on). Models with no reasoning support get no reasoning parameters at all. For a model the table doesn't know, the converter starts at `max` and steps down one level per upstream rejection, so a new model costs one extra round trip instead of a failed request. Each dialect gets the setting in its own shape: `reasoning_effort` for chat, `reasoning.effort` for Responses, `thinking.budget_tokens` for Anthropic (clamped below `max_tokens`, and skipped when there is no room), `thinkingConfig.thinkingBudget` for Gemini.

Set `FORCE_MAX_REASONING=0` to respect whatever the client asked for instead.

## When the model thinks but says nothing

Reasoning-heavy models routinely burn their whole token budget on internal thinking and return an empty answer, or go quiet for minutes before the first byte. Those are treated as retryable, not as failures:

| Situation | Behavior |
|---|---|
| No response headers yet | wait up to **120 s** (`UPSTREAM_HEADER_TIMEOUT_MS`), then reconnect |
| Connected, no data yet | wait up to **300 s** (`UPSTREAM_STALL_TIMEOUT_MS`), then restart the attempt |
| Answer arrives with no text, tool calls, or reasoning | restart the attempt |
| Restart budget | **30 attempts** (`UPSTREAM_EMPTY_RETRIES`) |

Each restart doubles the token budget (from 2 048 up to 200 000), because the usual cause is reasoning consuming everything before the visible answer starts. Restarts only happen while your client has received nothing, so output is never duplicated; successful requests report the count in `x-opencode-empty-retries`.

## Surviving a dropped internet connection

Connectivity failures get their own, much larger budget than "upstream is busy" failures, because the right response to a dead network is patient reconnection:

| | Connectivity failures (dropped connection, DNS/TLS failure, timeout) | Upstream busy (429 / 502 / 503 / 529) |
|---|---|---|
| Attempts | **150** (`UPSTREAM_NETWORK_RETRIES`, max 1000) | 3 (`UPSTREAM_RETRIES`, max 20) |
| Deadline | 15 min (`UPSTREAM_NETWORK_DEADLINE_MS`) | 90 s (`UPSTREAM_TOTAL_DEADLINE_MS`) |
| Backoff | 250 ms → 500 ms → 1 s → 2 s → 5 s steady, jittered (`UPSTREAM_NETWORK_DELAY_CAP_MS`) | exponential to 9 s, honors `Retry-After` |

The two budgets are independent: a reconnect never consumes a status retry, and vice versa.

**Streams heal themselves too.** If the connection dies *before your client has received any bytes* — including mid-SSE — the request is transparently reopened and restarted from scratch (emitter and reasoning guard reset, so nothing is replayed twice). Once bytes have reached your client a restart would duplicate output, so instead you get a clear error event explaining that the partial reply is all that arrived.

Non-streaming requests reconnect the same way while reading the response body. Successful requests that needed reconnects report them in `x-opencode-reconnects` (streaming responses can't, since SSE headers are sent first).

Retries stop immediately when your client disconnects, and the model list plus the CLI-version lookup fall back to cached values during an outage, so a dead network never turns into a hang.

> **Platform caveat:** Cloudflare caps outbound subrequests per request (50 on the Free plan, 1000 on paid), so a deployed Free-plan worker can only make ~45 reconnect attempts before the platform refuses. When that happens the error says so explicitly instead of failing cryptically. Local `wrangler dev` and paid plans use the full 150.

## Timeouts (no more infinite hangs)

Every upstream call is bounded; a request can never hang forever:

| Layer | Default | Env var |
|---|---|---|
| zen must send response headers | 20 s | `UPSTREAM_HEADER_TIMEOUT_MS` |
| retry attempts on 429/5xx/timeout | 3 (max 6) | `UPSTREAM_RETRIES` |
| whole retry sequence | 90 s | `UPSTREAM_TOTAL_DEADLINE_MS` |
| non-streaming body must finish | 240 s | `UPSTREAM_BODY_TIMEOUT_MS` |
| stream stall — no SSE data | 60 s | `UPSTREAM_STALL_TIMEOUT_MS` |
| whole stream | 570 s | `STREAM_DEADLINE_MS` |

On timeout the client gets a clean error in its own API format (streaming clients get an SSE error event, and OpenAI-format streams still terminate with `finish_reason` + `[DONE]`); hung upstream connections are retried automatically, retries stop as soon as your client disconnects, and disconnecting aborts the upstream fetch.

## Robustness guarantees

The converter is defensive about upstream behavior that would otherwise surface as a silent failure:

- **Streams that end without a terminator** get a synthesized stop (routed through the empty-answer guard, so a reasoning-only answer still yields text).
- **Mid-stream upstream errors** are forwarded as a proper error event before the stream closes, instead of being masked by a "completed" event.
- **Non-stream requests answered with SSE** (and stream requests answered with JSON) are folded into the right shape rather than failing to parse.
- **Tool calls truncated mid-arguments** are still surfaced with their partial arguments instead of vanishing.
- **A stale or fallback model list never rejects a model**: unknown ids are forwarded to zen, which is authoritative.

## Notes & limits

- Responses streaming uses Cloudflare Workers' CPU limits (`cpu_ms = 30000` in `wrangler.toml`); long generations stream fine but adjust to taste.
- The live model list is cached 5 minutes; a static fallback list keeps `/v1/models` and routing alive even if zen's list endpoint hiccups.
- `cost` returned by zen is passed through (`cost` field on chat completions, `usage.cost` on responses).
- No request logging, no key storage, no state: everything lives in the request/response cycle (the only caches are the public model list and the public CLI version).

## Repo layout

```
src/index.ts          router, CORS, auth extraction, /v1/models
src/pipeline.ts       completion pipeline (parse → route → call → convert)
src/canonical.ts      canonical request/response/event model
src/parse/requests.ts inbound: chat-completions / messages / responses → canonical
src/parse/streams.ts  upstream SSE (4 dialects) → canonical events
src/build/zen.ts      canonical → zen native bodies (4 dialects)
src/build/streams.ts  canonical events → 3 public SSE formats
src/build/responses.ts upstream JSON → canonical → 3 public formats
src/zen.ts            zen client: headers/identity, endpoint routing, model list
src/version.ts        auto-updating CLI version (npm → github → fallback)
test/convert.test.ts  unit tests (vitest)
```

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run dev         # wrangler dev
```
