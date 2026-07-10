/**
 * TokDash shared constants: harness allowlist, subcommand allowlist,
 * validation regexes (PROMPT.md §3.1), and defaults.
 *
 * This module contains ONLY constants and trivial pure label/threshold
 * helpers — no I/O, no aggregation logic.
 */

import type { DatePreset } from "./types";

/* ------------------------------------------------------------------ */
/* Harnesses                                                           */
/* ------------------------------------------------------------------ */

/**
 * The 15 harnesses ccusage v20 can detect (PROMPT.md §2.2). Agents observed
 * in data but NOT listed here are still aggregated and surfaced as chips
 * (degrade-with-warning) — but per-agent subcommands are only ever executed
 * for names on this list (command-construction safety).
 */
export const KNOWN_HARNESSES = [
  "claude",
  "codex",
  "opencode",
  "amp",
  "droid",
  "codebuff",
  "hermes",
  "pi",
  "goose",
  "kilo",
  "copilot",
  "gemini",
  "kimi",
  "qwen",
  "openclaw",
] as const;

export type KnownHarness = (typeof KNOWN_HARNESSES)[number];

export const KNOWN_HARNESS_SET: ReadonlySet<string> = new Set(KNOWN_HARNESSES);

/* ------------------------------------------------------------------ */
/* Validation regexes (§3.1)                                           */
/* ------------------------------------------------------------------ */

/** Dates appended to the command line / accepted from the API: YYYY-MM-DD. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Months: YYYY-MM (unified monthly `period`). */
export const MONTH_RE = /^\d{4}-\d{2}$/;

/** IANA timezone tokens appended to the command line (§3.1 verbatim). */
export const TZ_RE = /^[A-Za-z_+\-/0-9]+$/;

/** Host series colors in config: #rrggbb. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Agent names considered structurally safe (defensive check, in addition to the allowlist). */
export const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_PORT = 4114;
export const DEFAULT_FETCH_WINDOW_DAYS = 90;
export const DEFAULT_REFRESH_INTERVAL_MINUTES = 15;

/** All FR1 date presets, in display order. */
export const DATE_PRESETS: readonly DatePreset[] = [
  "today",
  "7d",
  "14d",
  "30d",
  "60d",
  "90d",
  "mtd",
];

/** Default range when GET /api/usage omits `from` (FR1: default 30d). */
export const DEFAULT_DATE_PRESET: DatePreset = "30d";

/** FR3: model stacking shows top 8 models by cost + "other". */
export const TOP_MODELS_DEFAULT = 8;

/** FR4: sessions table caps at top 100 by cost. */
export const TOP_SESSIONS_DEFAULT = 100;

/* ------------------------------------------------------------------ */
/* GET /api/usage date-range bounds (hostile-input hardening)          */
/* ------------------------------------------------------------------ */

/**
 * Hard floor for the usage filter's `from`. Nothing in any harness store
 * predates 2000, and an unbounded `from` (e.g. 0001-01-01) would make the
 * zero-filled axis materialize millions of entries — enough to OOM the
 * server from a single hand-typed URL. Also keeps every axis year >= 100,
 * where Date.UTC has no two-digit-year remapping surprises.
 */
export const MIN_USAGE_FROM = "2000-01-01";

/**
 * Maximum inclusive span (in days) of a usage filter range: ~10 years.
 * Far beyond any preset (max 90d) and any realistic ccusage history, but
 * small enough that the zero-filled chart series stay cheap.
 */
export const MAX_USAGE_RANGE_DAYS = 3660;

/* ------------------------------------------------------------------ */
/* Series-key sentinels (model stack dimension)                        */
/* ------------------------------------------------------------------ */

/**
 * StackedPoint.values key for the aggregated "other" model bucket.
 * Model names are opaque, so sentinels use a `__…__` shape real ccusage
 * model labels have never been observed to use.
 */
export const OTHER_MODELS_KEY = "__other__";
export const OTHER_MODELS_LABEL = "Other";

const NO_MODEL_DATA_KEY_PREFIX = "__no_model_data__:";

/** Series key for a harness whose source lacks per-day model data (FR3 fallback). */
export function noModelDataKey(agent: string): string {
  return `${NO_MODEL_DATA_KEY_PREFIX}${agent}`;
}

/** Display label for that band, e.g. "hermes — no model data". */
export function noModelDataLabel(agent: string): string {
  return `${agent} — no model data`;
}

/** True if a series key was produced by noModelDataKey. */
export function isNoModelDataKey(key: string): boolean {
  return key.startsWith(NO_MODEL_DATA_KEY_PREFIX);
}

/* ------------------------------------------------------------------ */
/* Freshness & execution budgets                                       */
/* ------------------------------------------------------------------ */

/**
 * A snapshot counts as "fresh" while its age is <= 2× the configured
 * auto-refresh interval; older => "stale".
 */
export function staleAfterMs(refreshIntervalMinutes: number): number {
  return refreshIntervalMinutes * 2 * 60_000;
}

/** Budget per ccusage invocation (§2.1). */
export const INVOCATION_TIMEOUT_MS = 45_000;
