/**
 * Cross-host merger. Hosts are INDEPENDENT: the same date appearing on two
 * hosts is two distinct facts whose costs/tokens ADD — never dedup, never
 * prefer one host over another (see
 * fixtures/synthetic/duplicate-day-hostA/B-daily.json: 2026-06-01 must merge
 * to 125.5 + 15.752521 = 141.252521).
 *
 * The merger does NOT collapse hosts into one table — MergedDataset keeps
 * per-host data (charts stack by host, per-host cumulative lines, host
 * breakdown table). Cross-host summation helpers live here and in
 * aggregate.ts.
 *
 * Pure functions only — no I/O.
 */

import type {
  DateString,
  HostMergeInput,
  HostUsageData,
  MergedDataset,
  UsageTotals,
} from "./types";

/** A fresh, empty HostUsageData (used for hosts with no snapshot yet). */
export function emptyHostUsageData(): HostUsageData {
  return { daily: [], monthly: [], sessions: [], agentDaily: {}, agents: [] };
}

/**
 * Build the merged multi-host dataset the aggregator consumes.
 *  - One MergedHostData per input, in input order, carrying the host's
 *    config identity (id/label/color/enabled), its normalized data
 *    (emptyHostUsageData() when snapshot is null), fetchedAt, error, and
 *    the snapshot's fetch window.
 *  - `agents` = sorted (asc) union of every host's observed agents.
 *  - `coverage` = intersection of the windows of hosts that HAVE a snapshot:
 *    { from: max(all window.from), to: min(all window.to) }; null when no
 *    host has a snapshot or the intersection is empty (from > to).
 *  - Duplicate host ids are kept as-is (config validation prevents them
 *    upstream); nothing is deduplicated.
 * Never throws.
 */
export function mergeHosts(inputs: HostMergeInput[]): MergedDataset {
  const hosts = inputs.map(({ host, snapshot }) => ({
    hostId: host.id,
    label: host.label,
    color: host.color,
    enabled: host.enabled,
    data: snapshot !== null ? snapshot.data : emptyHostUsageData(),
    fetchedAt: snapshot !== null ? snapshot.fetchedAt : null,
    error: snapshot !== null ? snapshot.error : null,
    window: snapshot !== null ? snapshot.window : null,
    // Retain normalized section warnings for compatibility with hand-built
    // or older cached datasets. Unified refresh failures now degrade a host.
    sectionFailures:
      snapshot !== null
        ? snapshot.warnings
            .filter((w) => w.code === "section-failed")
            .map((w) => w.message)
        : [],
  }));

  const agentSet = new Set<string>();
  for (const h of hosts) for (const a of h.data.agents) agentSet.add(a);
  const agents = [...agentSet].sort();

  let coverage: MergedDataset["coverage"] = null;
  const windows = inputs
    .filter((i) => i.snapshot !== null)
    .map((i) => i.snapshot!.window);
  if (windows.length > 0) {
    let from = windows[0]!.from;
    let to = windows[0]!.to;
    for (const w of windows) {
      if (w.from > from) from = w.from;
      if (w.to < to) to = w.to;
    }
    coverage = from <= to ? { from, to } : null;
  }

  return { hosts, agents, coverage };
}

/**
 * Additive per-day totals across hosts (unified daily rows only — the
 * authoritative all-harness numbers). Keys are dates present on ANY included
 * host (NOT zero-filled — aggregate.ts zero-fills against its axis).
 *  - `hostIds` restricts which hosts contribute; null/undefined = all hosts
 *    in the dataset.
 *  - Duplicate dates across hosts ADD field-by-field in full precision
 *    (cost and all five token fields).
 * Returned Map iterates in ascending date order.
 */
export function combinedDailyTotals(
  dataset: MergedDataset,
  hostIds?: readonly string[] | null,
): Map<DateString, UsageTotals> {
  const include = hostIds == null ? null : new Set(hostIds);
  const acc = new Map<DateString, UsageTotals>();
  for (const host of dataset.hosts) {
    if (include !== null && !include.has(host.hostId)) continue;
    for (const row of host.data.daily) {
      const cur = acc.get(row.date);
      if (cur === undefined) {
        acc.set(row.date, {
          cost: row.cost,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheCreationTokens: row.cacheCreationTokens,
          cacheReadTokens: row.cacheReadTokens,
          totalTokens: row.totalTokens,
        });
      } else {
        cur.cost += row.cost;
        cur.inputTokens += row.inputTokens;
        cur.outputTokens += row.outputTokens;
        cur.cacheCreationTokens += row.cacheCreationTokens;
        cur.cacheReadTokens += row.cacheReadTokens;
        cur.totalTokens += row.totalTokens;
      }
    }
  }
  return new Map(
    [...acc.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}
