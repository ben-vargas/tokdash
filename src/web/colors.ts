/**
 * Categorical color system — design brief §2. Three independent palettes:
 * hosts (config-owned, arrive via HostRef.color), harnesses (fixed 8 + 2
 * overflow), models (ranked ramp by cost). Never hash names to colors.
 */

import { OTHER_MODELS_KEY, isNoModelDataKey } from "../shared/constants";
import type { SeriesKey, UsageResponse } from "../shared/types";

/** Fixed harness assignments (brief §2.2), identical on both themes. */
export const HARNESS_COLORS: Readonly<Record<string, string>> = {
  claude: "#d97757",
  codex: "#5da9e9",
  hermes: "#e0709e",
  pi: "#9dc45f",
  droid: "#4cc9e0",
  opencode: "#c084e8",
  gemini: "#e8c268",
  amp: "#5fbf9a",
  // Emerald: fills the palette's green gap; validated (dataviz six checks)
  // against its legend neighbors hermes/opencode on both surfaces — worst
  // adjacent CVD pair stays the pre-existing codex↔droid, not omp.
  omp: "#2eb873",
};

/** Overflow pair for unknown harnesses — muted on purpose (brief §2.2). */
export const UNKNOWN_HARNESS_COLORS = ["#8a837a", "#6f7d8c"] as const;

/** Ranked model ramp — rank 1 (highest cost) gets m1 (brief §2.3). */
export const MODEL_RAMP = [
  "#6f9ef2",
  "#e0876b",
  "#58c1a8",
  "#c58cf0",
  "#e5c05e",
  "#d876a8",
  "#7fc470",
  "#62b8d8",
] as const;

export const OTHER_MODEL_COLOR = "#8d867e";

/** Token-composition class colors (brief §6.3); cache-read is themed. */
export const TOKEN_CLASS_COLORS = {
  inputTokens: "var(--tok-input)",
  outputTokens: "var(--tok-output)",
  cacheCreationTokens: "var(--tok-cache-create)",
  cacheReadTokens: "var(--tok-cache-read)",
} as const;

/**
 * Build the harness → color map for a dataset. Known harnesses use the
 * fixed table; unknowns alternate between the two overflow colors in
 * ascending name order — deterministic within a dataset.
 */
export function buildHarnessColorMap(
  agents: readonly string[],
): Map<string, string> {
  const map = new Map<string, string>();
  const unknowns = agents
    .filter((a) => !(a in HARNESS_COLORS))
    .sort((a, b) => a.localeCompare(b));
  for (const agent of agents) {
    const fixed = HARNESS_COLORS[agent];
    if (fixed !== undefined) {
      map.set(agent, fixed);
    }
  }
  unknowns.forEach((agent, i) => {
    map.set(agent, UNKNOWN_HARNESS_COLORS[i % 2] as string);
  });
  return map;
}

export function harnessColor(
  agent: string,
  map: ReadonlyMap<string, string>,
): string {
  return map.get(agent) ?? (UNKNOWN_HARNESS_COLORS[0] as string);
}

/** Host id → config color from the usage response. */
export function buildHostColorMap(usage: UsageResponse): Map<string, string> {
  return new Map(usage.availableHosts.map((h) => [h.id, h.color]));
}

/**
 * Resolve the color for a stacked-series key of any dimension.
 * `modelRankIndex` = index of the key among kind==="model" keys in API
 * order (cost rank). No-model-data bands get the harness color (the
 * 40%-opacity hatch is applied at render time).
 */
export function seriesKeyColor(
  key: SeriesKey,
  modelRankIndex: number,
  hostColors: ReadonlyMap<string, string>,
  agentColors: ReadonlyMap<string, string>,
): string {
  switch (key.kind) {
    case "host":
      return hostColors.get(key.id) ?? OTHER_MODEL_COLOR;
    case "agent":
      return harnessColor(key.id, agentColors);
    case "model":
      return MODEL_RAMP[modelRankIndex % MODEL_RAMP.length] as string;
    case "other":
      return OTHER_MODEL_COLOR;
    case "no-model-data": {
      const agent = key.id.split(":").slice(1).join(":");
      return harnessColor(agent, agentColors);
    }
  }
}

/** True when the key renders as a hatched band (brief §2.3). */
export function isHatchedKey(key: SeriesKey): boolean {
  return key.kind === "no-model-data" || isNoModelDataKey(key.id);
}

/**
 * Safe DOM id for SVG pattern defs — series ids are opaque strings
 * (model names contain spaces/colons/slashes); never use them raw.
 */
export function patternId(prefix: string, raw: string): string {
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}

export { OTHER_MODELS_KEY };
