/**
 * FR1 — full filter state lives in the URL query string (shareable,
 * survives reload). Read once on boot; history.replaceState on change.
 * No router library.
 *
 * URL shape (defaults omitted so the default view is a clean URL):
 *   ?preset=7d                    — an active preset other than 30d
 *   ?from=YYYY-MM-DD&to=…         — custom range (no preset param)
 *   ?hosts=a,b | hosts=none       — host subset / explicit empty
 *   ?agents=x,y | agents=none     — harness subset / explicit empty
 */

import { useEffect, useMemo, useState } from "react";
import { DATE_PRESETS, DATE_RE, DEFAULT_DATE_PRESET } from "../../shared/constants";
import { isValidDateString, resolvePreset } from "../../shared/dates";
import type { DatePreset, DateRange, DateString } from "../../shared/types";

const NONE = "none";

export interface FilterState {
  /** Active preset, or null when a custom from/to range is active. */
  preset: DatePreset | null;
  /** Custom range; only meaningful when preset === null. */
  custom: DateRange | null;
  /** null = all hosts; [] = explicitly none. */
  hosts: string[] | null;
  /** null = all harnesses; [] = explicitly none. */
  agents: string[] | null;
}

export const DEFAULT_FILTERS: FilterState = {
  preset: DEFAULT_DATE_PRESET,
  custom: null,
  hosts: null,
  agents: null,
};

function parseList(value: string | null): string[] | null {
  if (value === null) return null;
  if (value === NONE) return [];
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const deduped = [...new Set(items)];
  return deduped.length === 0 ? null : deduped;
}

export function parseFiltersFromUrl(search: string): FilterState {
  const qs = new URLSearchParams(search);
  const presetRaw = qs.get("preset");
  const from = qs.get("from");
  const to = qs.get("to");
  let preset: DatePreset | null = DEFAULT_DATE_PRESET;
  let custom: DateRange | null = null;
  if (presetRaw !== null && (DATE_PRESETS as readonly string[]).includes(presetRaw)) {
    preset = presetRaw as DatePreset;
  } else if (
    from !== null &&
    to !== null &&
    DATE_RE.test(from) &&
    DATE_RE.test(to) &&
    isValidDateString(from) &&
    isValidDateString(to) &&
    from <= to
  ) {
    preset = null;
    custom = { from, to };
  }
  return {
    preset,
    custom,
    hosts: parseList(qs.get("hosts")),
    agents: parseList(qs.get("agents")),
  };
}

export function serializeFilters(state: FilterState): string {
  const qs = new URLSearchParams();
  if (state.preset !== null) {
    if (state.preset !== DEFAULT_DATE_PRESET) qs.set("preset", state.preset);
  } else if (state.custom !== null) {
    qs.set("from", state.custom.from);
    qs.set("to", state.custom.to);
  }
  if (state.hosts !== null) {
    qs.set("hosts", state.hosts.length === 0 ? NONE : state.hosts.join(","));
  }
  if (state.agents !== null) {
    qs.set("agents", state.agents.length === 0 ? NONE : state.agents.join(","));
  }
  const s = qs.toString();
  return s.length > 0 ? `?${s}` : "";
}

/** Resolve the active date range for a given "today" in the config tz. */
export function resolveFilterRange(
  state: FilterState,
  today: DateString,
): DateRange {
  if (state.preset !== null) return resolvePreset(state.preset, today);
  if (state.custom !== null) return state.custom;
  return resolvePreset(DEFAULT_DATE_PRESET, today);
}

/** Toggle an id within a null-means-all selection over `allIds`. */
export function toggleSelection(
  current: string[] | null,
  allIds: readonly string[],
  id: string,
): string[] | null {
  const effective = new Set(current ?? allIds);
  if (effective.has(id)) {
    effective.delete(id);
  } else {
    effective.add(id);
  }
  // Normalize back to null when the selection covers every known id.
  if (allIds.length > 0 && allIds.every((x) => effective.has(x))) return null;
  return allIds.filter((x) => effective.has(x));
}

export interface UseFiltersResult {
  filters: FilterState;
  setPreset: (preset: DatePreset) => void;
  setCustomRange: (range: DateRange) => void;
  toggleHost: (id: string, allIds: readonly string[]) => void;
  toggleAgent: (id: string, allIds: readonly string[]) => void;
  resetFilters: () => void;
}

export function useFilters(): UseFiltersResult {
  const [filters, setFilters] = useState<FilterState>(() =>
    parseFiltersFromUrl(window.location.search),
  );

  // The URL is derived from committed state (replaceState — deliberately
  // no history entries for within-app filter changes). Every setter uses
  // functional setState so multiple toggles dispatched in the same JS
  // task compose instead of clobbering each other from a stale snapshot.
  useEffect(() => {
    const next = `${window.location.pathname}${serializeFilters(filters)}`;
    const current = `${window.location.pathname}${window.location.search}`;
    if (next !== current) window.history.replaceState(null, "", next);
  }, [filters]);

  return useMemo(
    () => ({
      filters,
      setPreset: (preset) =>
        setFilters((prev) => ({ ...prev, preset, custom: null })),
      setCustomRange: (range) =>
        setFilters((prev) => ({ ...prev, preset: null, custom: range })),
      toggleHost: (id, allIds) =>
        setFilters((prev) => ({
          ...prev,
          hosts: toggleSelection(prev.hosts, allIds, id),
        })),
      toggleAgent: (id, allIds) =>
        setFilters((prev) => ({
          ...prev,
          agents: toggleSelection(prev.agents, allIds, id),
        })),
      resetFilters: () => setFilters(DEFAULT_FILTERS),
    }),
    [filters],
  );
}
