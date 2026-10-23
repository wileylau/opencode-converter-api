/**
 * Upstream identity: the project/session pair sent to zen as `x-opencode-project`
 * and `x-opencode-session`.
 *
 * Two modes:
 *  - opencode installed on the host (detected by `npm run dev`): the proxy gets
 *    its own persisted project id, and one stable session under it.
 *  - otherwise (deployed Worker, Docker, plain `wrangler dev`): clients without
 *    their own session id share a deterministic weekly fallback, so the
 *    identity stays stable for a week instead of changing on every request.
 */

import { stableProjectId } from "./util";

const ID_RE = /^[-\w.]{8,128}$/;

function envString(env: Record<string, unknown> | undefined, key: string): string | null {
  const v = env?.[key];
  return typeof v === "string" && ID_RE.test(v.trim()) ? v.trim() : null;
}

/** True when `npm run dev` found an opencode installation on the host. */
export function opencodeIsInstalled(env: Record<string, unknown> | undefined): boolean {
  const v = env?.["OPENCODE_INSTALLED"];
  return v === 1 || v === true || (typeof v === "string" && /^(1|true|yes)$/i.test(v.trim()));
}

/**
 * The project the proxy speaks as. Uses the persisted proxy project id when one
 * was provided (see scripts/dev.mjs), otherwise a per-isolate stable uuid.
 */
export function proxyProjectId(env: Record<string, unknown> | undefined): string {
  return envString(env, "OPENCODE_PROJECT_ID") ?? stableProjectId();
}

/** ISO-8601 week number in UTC. */
export function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

/**
 * Deterministic fallback session: one constant per ISO week, e.g.
 * `ses_conv_w2026_43`. No state, and it only changes on Monday.
 */
export function weeklySessionId(date: Date = new Date()): string {
  const { year, week } = isoWeek(date);
  return `ses_conv_w${year}_${String(week).padStart(2, "0")}`;
}

/**
 * The session id used when the client did not send one.
 *  - opencode installed + proxy project id: one stable session under that project.
 *  - otherwise: the weekly fallback above.
 */
export function defaultSessionId(env: Record<string, unknown> | undefined, date: Date = new Date()): string {
  if (opencodeIsInstalled(env)) {
    const project = envString(env, "OPENCODE_PROJECT_ID");
    if (project) return `ses_conv_${project}`.slice(0, 128);
  }
  return weeklySessionId(date);
}
