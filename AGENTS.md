# AGENTS.md

Cloudflare Worker (TypeScript, ESM) that proxies opencode zen behind three public APIs:
OpenAI Chat Completions (`/v1/chat/completions`), Anthropic Messages (`/v1/messages`),
OpenAI Responses (`/v1/responses`), plus `/v1/models`. No framework: `src/index.ts`
exports the default `fetch` handler. Deployed with Wrangler.

## Commands

```bash
npm install            # required first; node_modules is not committed
npm run typecheck      # tsc --noEmit (there is no lint/format script)
npm test               # vitest run (all tests)
npx vitest run test/convert.test.ts -t "substring"   # single test / describe
npm run dev            # wrangler dev via scripts/dev.mjs
npm run deploy         # wrangler deploy (needs: npx wrangler login)
```

`npm run dev` probes for the first free port starting at 8787 (override with `PORT=9000`);
it prints the actual URL. Local dev needs no Cloudflare account.

## Architecture

Single request flow; every layer must stay in sync:

```
inbound JSON -> src/parse/requests.ts -> src/canonical.ts
            -> src/build/zen.ts -> src/zen.ts (callZen) -> src/pipeline.ts (retry/repair)
            -> src/parse/streams.ts | src/build/responses.ts -> src/build/streams.ts
```

- Adding or translating a field usually touches `canonical.ts`, `parse/requests.ts`,
  `build/zen.ts`, the corresponding stream parser/emitter, and tests — not one dialect.
- `CanonicalRequest.extras` is intentionally always empty: unmapped client params are
  dropped because zen returns 400 for unknown fields. Don't start forwarding them.
- Zen endpoint routing is model-family based (`pickEndpoint` in `src/zen.ts`). The wrong
  native dialect fails, so route via the live model family map, then name prefixes.
- Long/invalid tool names are aliased to `t_<hash>` outbound and restored on every
  response and stream event (`src/tools.ts`). Keep aliasing consistent across tool
  definitions, history, `tool_choice`, and streams.
- `src/pipeline.ts` is the orchestration hub: retry/reconnect, empty-answer recovery,
  param-repair passes, format conversion. Read it before changing request behavior.

## Load-bearing upstream behavior

- Zen's free tier only serves CLI-like clients. `src/zen.ts` sends
  `User-Agent: opencode/<version>`, `Authorization: Bearer public` when keyless, and
  `x-opencode-*` identity headers. Removing/changing these breaks free models (429).
- Version is fetched live from npm (1h cache); `FALLBACK_VERSION` pins it.
- Status retries (429/502/503/529) and connectivity reconnects use **separate budgets**.
  Never retry once bytes have reached the client. Deployed Free plan caps outbound
  subrequests (~45 reconnects); local dev and paid plans use the full 150.
- Reasoning is forced to each model's max by default (`FORCE_MAX_REASONING=0` disables).
  Known models live in `MAX_EFFORT` in `src/reasoning.ts`; unknown models start at
  `max` and step down on upstream rejection.
- Identity (`x-opencode-project` / `x-opencode-session`) comes from `src/identity.ts`.
  `scripts/dev.mjs` detects an installed opencode, creates one persisted proxy project
  (`.wrangler/opencode-converter-project-id`), and injects `OPENCODE_INSTALLED` /
  `OPENCODE_PROJECT_ID`. Without them, clients that send no session header share one
  deterministic weekly session. Never mint a new id per request or retry.

## Config

- `worker-configuration.d.ts` is **hand-maintained**, not generated despite the name.
  Add new env vars there and to `WorkerEnv` in `src/index.ts`.
- All env vars are optional with defaults; the full table is in `README.md`. Secrets go
  through `npx wrangler secret put GATEWAY_KEY` / `DEFAULT_ZEN_KEY`.
- `wrangler.toml` needs `nodejs_compat`. `[limits] cpu_ms` is paid-plan-only — a Free
  deploy fails with error 100328 if it is set.

## Tests

- All tests live in `test/convert.test.ts`: offline unit tests, no network or `fetch`
  mocks. Fixtures are inline; reuse the `streamFromText` / `collect` helpers.
- Vitest globals are off (`vitest.config.ts`): import `describe`/`it`/`expect` from
  `vitest`. Several tests dynamically import a module inside the test.
- TypeScript is strict with `noUncheckedIndexedAccess`; indexed reads use `!`.
  ESM + `isolatedModules`: use `import type` for type-only imports.

## Gotchas

- Comments and README files contain non-ASCII (`→`, `—`). Read them with the Read tool;
  Windows `Get-Content` output can show mojibake.
- Documentation is bilingual: keep `README.md` and `README.fa.md` in sync when changing
  endpoints, env vars, or behavior.
