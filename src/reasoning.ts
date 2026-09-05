/**
 * Reasoning effort policy.
 *
 * Goal: always run each model at the highest reasoning setting it supports,
 * descending `max → xhigh → high → medium → low → minimal → none` when the
 * upstream rejects a level.
 *
 * Two sources of truth, in order:
 *   1. MAX_EFFORT — a static table of the levels each zen model advertises
 *      (snapshotted from models.dev; cheap and needs no extra subrequest).
 *   2. the descend chain — for unknown/new models we start at `max` and step
 *      down whenever the upstream 400s about the effort value, so a wrong guess
 *      costs one extra round trip instead of a failed request.
 */

export const EFFORT_CHAIN = ["max", "xhigh", "high", "medium", "low", "minimal", "none"] as const;
export type Effort = (typeof EFFORT_CHAIN)[number];

/** Highest advertised effort per model. `null` = model has no reasoning at all. */
const MAX_EFFORT: Record<string, Effort | null | "unlabelled"> = {
  "claude-3-5-haiku": null,
  "claude-fable-5": "max",
  "claude-fable-5-1": "max",
  "claude-opus-4-5": "high",
  "claude-opus-4-6": "max",
  "claude-opus-4-7": "max",
  "claude-opus-4-8": "max",
  "claude-opus-5": "max",
  "claude-sonnet-4-5": "high",
  "claude-sonnet-4-6": "max",
  "claude-sonnet-5": "max",
  "deepseek-v4-flash": "max",
  "deepseek-v4-flash-free": "max",
  "deepseek-v4-pro": "max",
  "gemini-3-flash": "high",
  "gemini-3-pro": "high",
  "gemini-3.1-pro": "high",
  "gemini-3.5-flash": "high",
  "gemini-3.5-flash-lite": "high",
  "gemini-3.6-flash": "high",
  "gemini-3.7-flash": "high",
  "gemini-3.8-flash": "high",
  "glm-5.2": "max",
  "glm-5.3": "max",
  "glm-5.3-flash": "max",
  "gpt-5": "high",
  "gpt-5-codex": "high",
  "gpt-5-nano": "high",
  "gpt-5.1": "high",
  "gpt-5.1-codex": "high",
  "gpt-5.1-codex-max": "xhigh",
  "gpt-5.1-codex-mini": "high",
  "gpt-5.2": "xhigh",
  "gpt-5.2-codex": "xhigh",
  "gpt-5.3-codex": "xhigh",
  "gpt-5.3-codex-spark": "xhigh",
  "gpt-5.4": "xhigh",
  "gpt-5.4-mini": "xhigh",
  "gpt-5.4-nano": "xhigh",
  "gpt-5.4-pro": "xhigh",
  "gpt-5.5": "xhigh",
  "gpt-5.5-pro": "xhigh",
  "gpt-5.6-luna": "max",
  "gpt-5.6-sol": "max",
  "gpt-5.6-terra": "max",
  "grok-4.5": "xhigh",
  "grok-4.6": "xhigh",
  "kimi-k3": "max",
  "ling-2.6-flash-free": null,
  "muse-spark-1.2": "xhigh",
  "muse-spark-1.2-contributor-free": "xhigh",
  "muse-spark-1.3": "max",
  "muse-spark-1.3-contributor-free": "xhigh",
  "north-mini-code-free": "high",
  "qwen3-coder": null,
  "trinity-large-preview-free": null,
  "x-preview-f-free": "max",
};

/** Models that reason but don't advertise discrete effort levels. */
const UNLABELLED_PREFIXES = ["big-pickle", "kimi-", "minimax-", "nemotron-", "mimo-", "ling-", "ring-", "longcat-", "hy3", "laguna-", "qwen3."];

export interface EffortPlan {
  /** the effort to send, or undefined to send no reasoning controls at all */
  effort: Effort | undefined;
  /** true when the level came from the static table (a 400 is then surprising) */
  known: boolean;
}

/** Highest effort worth trying first for a model. */
export function planMaxEffort(model: string): EffortPlan {
  const entry = MAX_EFFORT[model];
  if (entry === null) return { effort: undefined, known: true };
  if (entry && entry !== "unlabelled") return { effort: entry, known: true };
  if (entry === "unlabelled") return { effort: undefined, known: true };
  // unknown model: try the ceiling and let the descend chain correct us
  if (UNLABELLED_PREFIXES.some((p) => model.startsWith(p))) return { effort: undefined, known: false };
  return { effort: "max", known: false };
}

/** Next lower level, or undefined once reasoning controls should be dropped entirely. */
export function lowerEffort(effort: Effort | undefined): Effort | undefined {
  if (!effort) return undefined;
  const i = EFFORT_CHAIN.indexOf(effort);
  if (i < 0 || i >= EFFORT_CHAIN.length - 1) return undefined;
  return EFFORT_CHAIN[i + 1];
}

/** True when an upstream error message is complaining about the reasoning setting. */
export function isReasoningRejection(message: string): boolean {
  return /reasoning|effort|thinking|budget_tokens|thinking_?budget/i.test(message);
}

/** Token budget for dialects that express effort as a thinking budget. */
export function effortBudgetTokens(effort: Effort): number {
  switch (effort) {
    case "max":
      return 32_000;
    case "xhigh":
      return 24_576;
    case "high":
      return 16_384;
    case "medium":
      return 8_192;
    case "low":
      return 2_048;
    case "minimal":
      return 1_024;
    case "none":
      return 0;
  }
}

/** OpenAI-family endpoints only accept a subset; map the rest onto it. */
export function effortForOpenAi(effort: Effort): string {
  return effort === "minimal" ? "low" : effort;
}
