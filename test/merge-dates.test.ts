/**
 * Phase-1 TDD tests: cross-host merger (src/shared/merge.ts) and date
 * helpers (src/shared/dates.ts).
 *
 * Every expected value here was derived INDEPENDENTLY of the code under
 * test — either by hand from calendar arithmetic, or straight from the
 * fixture JSON with jq (derivations quoted in comments). Fixture rows are
 * mapped to normalized shapes by a small hand-written mapper in this file
 * (NOT by src/shared/normalize.ts, which is also under test elsewhere).
 *
 * jq derivations (run 2026-07-02 against fixtures/synthetic):
 *   duplicate-day merged per-period sums (group_by(.period) | add):
 *     2026-06-01: cost 141.252521  (A 125.5      + B 15.752521)
 *                 input 6109809 output 327662 cacheCreate 630664
 *                 cacheRead 72435847 totalTokens 79503982
 *     2026-06-02: cost 94.695894   (A 60.25      + B 34.445894)
 *                 input 5828664 output 257702 cacheCreate 0
 *                 cacheRead 60834688 totalTokens 66921054
 *     grand cost: 235.948415
 *   zero-usage-gaps.json: 5 rows present in the 28-day window
 *     2026-06-01..2026-06-28; row costs 12.34 + 27.87125 + 3.104999
 *     + 9.500001 + 0.093729 = 52.909979 (equals the fixture's totals).
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  combinedDailyTotals,
  emptyHostUsageData,
  mergeHosts,
} from "../src/shared/merge";
import {
  addDays,
  compareDates,
  dateRangeInclusive,
  dayOfMonth,
  daysInMonth,
  diffDays,
  endOfMonth,
  isoToDateInTz,
  isValidDateString,
  isValidTimezone,
  maxDate,
  minDate,
  monthOf,
  monthToDateRange,
  previousPeriod,
  resolvePreset,
  startOfMonth,
  todayInTz,
} from "../src/shared/dates";
import type {
  DateRange,
  DateString,
  HostConfig,
  HostDailyRow,
  HostMergeInput,
  HostSnapshot,
  HostUsageData,
  MergedDataset,
  ModelBreakdown,
  UsageTotals,
} from "../src/shared/types";

const TZ = "America/Boise";
const FIXTURES = join(import.meta.dir, "..", "fixtures", "synthetic");

// ---------------------------------------------------------------------------
// Fixture loading + independent raw->normalized mapping (hand-written here so
// expectations never depend on src/shared/normalize.ts).
// ---------------------------------------------------------------------------

interface RawUnifiedDailyRow {
  period: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  metadata?: { agents?: string[] };
  modelsUsed?: string[];
  modelBreakdowns?: ModelBreakdown[];
}

interface RawUnifiedDailyReport {
  daily: RawUnifiedDailyRow[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalTokens: number;
    totalCost: number;
  };
}

function toHostDailyRow(raw: RawUnifiedDailyRow): HostDailyRow {
  return {
    date: raw.period,
    cost: raw.totalCost,
    // totalTokens copied VERBATIM — authoritative, never recomputed.
    totalTokens: raw.totalTokens,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cacheCreationTokens: raw.cacheCreationTokens,
    cacheReadTokens: raw.cacheReadTokens,
    agents: raw.metadata?.agents ?? [],
    modelsUsed: raw.modelsUsed ?? [],
    modelBreakdowns: raw.modelBreakdowns ?? [],
  };
}

async function loadUnifiedDailyRows(name: string): Promise<HostDailyRow[]> {
  const report = (await Bun.file(
    join(FIXTURES, name),
  ).json()) as RawUnifiedDailyReport;
  return report.daily.map(toHostDailyRow);
}

function makeData(
  daily: HostDailyRow[],
  agents: string[] = [],
): HostUsageData {
  return { daily, monthly: [], sessions: [], agentDaily: {}, agents };
}

function makeHost(id: string, overrides: Partial<HostConfig> = {}): HostConfig {
  return {
    id,
    label: `Host ${id}`,
    color: "#7c8cf8",
    enabled: true,
    ssh: null,
    ccusageCmd: "bunx ccusage@latest",
    ...overrides,
  };
}

function makeSnapshot(
  hostId: string,
  window: DateRange,
  data: HostUsageData,
  fetchedAt = "2026-07-02T12:00:00.000Z",
): HostSnapshot {
  return {
    hostId,
    fetchedAt,
    timezone: TZ,
    window,
    commands: [],
    raw: { unified: null },
    data,
    warnings: [],
    error: null,
  };
}

/** Two hosts whose unified daily windows overlap on the SAME two dates. */
async function loadDuplicateDayDataset(): Promise<MergedDataset> {
  const rowsA = await loadUnifiedDailyRows("duplicate-day-hostA-daily.json");
  const rowsB = await loadUnifiedDailyRows("duplicate-day-hostB-daily.json");
  const inputs: HostMergeInput[] = [
    {
      host: makeHost("hostA", { label: "Host A", color: "#4ec9b0" }),
      snapshot: makeSnapshot(
        "hostA",
        { from: "2026-06-01", to: "2026-06-30" },
        makeData(rowsA, ["claude", "codex"]),
      ),
    },
    {
      host: makeHost("hostB", { label: "Host B", color: "#e8a951" }),
      snapshot: makeSnapshot(
        "hostB",
        { from: "2026-06-01", to: "2026-06-30" },
        makeData(rowsB, ["hermes", "pi"]),
      ),
    },
  ];
  return mergeHosts(inputs);
}

// ---------------------------------------------------------------------------
// mergeHosts
// ---------------------------------------------------------------------------

describe("mergeHosts", () => {
  test("empty input => empty hosts, empty agents, null coverage", () => {
    const merged = mergeHosts([]);
    expect(merged.hosts).toEqual([]);
    expect(merged.agents).toEqual([]);
    expect(merged.coverage).toBeNull();
  });

  test("one MergedHostData per input, in input order, carrying config identity", () => {
    const snapA = makeSnapshot(
      "a",
      { from: "2026-06-01", to: "2026-06-30" },
      makeData([], ["claude"]),
    );
    const merged = mergeHosts([
      {
        host: makeHost("a", { label: "Alpha", color: "#112233", enabled: true }),
        snapshot: snapA,
      },
      {
        host: makeHost("b", {
          label: "Bravo",
          color: "#445566",
          enabled: false,
        }),
        snapshot: null,
      },
    ]);
    expect(merged.hosts.length).toBe(2);
    const a = merged.hosts[0]!;
    const b = merged.hosts[1]!;
    expect(a.hostId).toBe("a");
    expect(a.label).toBe("Alpha");
    expect(a.color).toBe("#112233");
    expect(a.enabled).toBe(true);
    expect(a.data).toEqual(snapA.data);
    expect(a.fetchedAt).toBe("2026-07-02T12:00:00.000Z");
    expect(a.error).toBeNull();
    expect(a.window).toEqual({ from: "2026-06-01", to: "2026-06-30" });
    // Snapshot-less host: empty data, null fetchedAt/error/window.
    expect(b.hostId).toBe("b");
    expect(b.label).toBe("Bravo");
    expect(b.enabled).toBe(false);
    expect(b.data).toEqual(emptyHostUsageData());
    expect(b.fetchedAt).toBeNull();
    expect(b.error).toBeNull();
    expect(b.window).toBeNull();
  });

  test("section-failed snapshot warnings ride along as sectionFailures (others filtered out)", () => {
    const snap = makeSnapshot(
      "a",
      { from: "2026-06-01", to: "2026-06-30" },
      makeData([], ["claude", "hermes"]),
    );
    snap.warnings = [
      { code: "section-failed", message: "agentDaily:hermes section failed: JSON Parse error" },
      { code: "row-skipped", message: "unified daily row skipped: bad period" },
      { code: "missing-field", message: "totalTokens absent" },
    ];
    const merged = mergeHosts([
      { host: makeHost("a"), snapshot: snap },
      { host: makeHost("b"), snapshot: null },
    ]);
    expect(merged.hosts[0]!.sectionFailures).toEqual([
      "agentDaily:hermes section failed: JSON Parse error",
    ]);
    expect(merged.hosts[1]!.sectionFailures).toEqual([]);
  });

  test("agents = sorted ascending union across hosts, unknown harness names kept", () => {
    const merged = mergeHosts([
      {
        host: makeHost("a"),
        snapshot: makeSnapshot(
          "a",
          { from: "2026-06-01", to: "2026-06-30" },
          makeData([], ["codex", "claude"]),
        ),
      },
      {
        host: makeHost("b"),
        snapshot: makeSnapshot(
          "b",
          { from: "2026-06-01", to: "2026-06-30" },
          // "warpspeed" is not in the 15-harness allowlist — must survive.
          makeData([], ["pi", "claude", "warpspeed", "hermes"]),
        ),
      },
    ]);
    expect(merged.agents).toEqual([
      "claude",
      "codex",
      "hermes",
      "pi",
      "warpspeed",
    ]);
  });

  test("coverage = intersection of snapshot windows: max(from), min(to)", () => {
    const merged = mergeHosts([
      {
        host: makeHost("a"),
        snapshot: makeSnapshot(
          "a",
          { from: "2026-04-03", to: "2026-07-02" },
          makeData([]),
        ),
      },
      {
        host: makeHost("b"),
        snapshot: makeSnapshot(
          "b",
          { from: "2026-05-15", to: "2026-06-28" },
          makeData([]),
        ),
      },
    ]);
    expect(merged.coverage).toEqual({ from: "2026-05-15", to: "2026-06-28" });
  });

  test("hosts WITHOUT a snapshot do not shrink coverage", () => {
    const merged = mergeHosts([
      {
        host: makeHost("a"),
        snapshot: makeSnapshot(
          "a",
          { from: "2026-04-03", to: "2026-07-02" },
          makeData([]),
        ),
      },
      { host: makeHost("never-fetched"), snapshot: null },
    ]);
    expect(merged.coverage).toEqual({ from: "2026-04-03", to: "2026-07-02" });
  });

  test("coverage is null when no host has a snapshot", () => {
    const merged = mergeHosts([
      { host: makeHost("a"), snapshot: null },
      { host: makeHost("b"), snapshot: null },
    ]);
    expect(merged.coverage).toBeNull();
  });

  test("coverage is null when windows are disjoint (empty intersection)", () => {
    const merged = mergeHosts([
      {
        host: makeHost("a"),
        snapshot: makeSnapshot(
          "a",
          { from: "2026-01-01", to: "2026-02-01" },
          makeData([]),
        ),
      },
      {
        host: makeHost("b"),
        snapshot: makeSnapshot(
          "b",
          // max(from)=2026-03-01 > min(to)=2026-02-01 => null
          { from: "2026-03-01", to: "2026-04-01" },
          makeData([]),
        ),
      },
    ]);
    expect(merged.coverage).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// combinedDailyTotals — duplicate dates across hosts ADD, never dedup
// ---------------------------------------------------------------------------

describe("combinedDailyTotals", () => {
  test("duplicate-day fixtures: same date on two hosts ADDS costs (README anchors)", async () => {
    const merged = await loadDuplicateDayDataset();
    const totals = combinedDailyTotals(merged);
    expect(totals.size).toBe(2);
    const d1 = totals.get("2026-06-01");
    const d2 = totals.get("2026-06-02");
    expect(d1).toBeDefined();
    expect(d2).toBeDefined();
    // jq: 125.5 + 15.752521 = 141.252521 ; 60.25 + 34.445894 = 94.695894
    expect(d1!.cost).toBeCloseTo(141.252521, 6);
    expect(d2!.cost).toBeCloseTo(94.695894, 6);
    // Grand total across the map: 235.948415
    let grand = 0;
    for (const t of totals.values()) grand += t.cost;
    expect(grand).toBeCloseTo(235.948415, 6);
  });

  test("duplicate-day fixtures: all five token fields add field-by-field (exact ints)", async () => {
    const merged = await loadDuplicateDayDataset();
    const totals = combinedDailyTotals(merged);
    const d1 = totals.get("2026-06-01")!;
    // jq sums: input 5002000+1107809, output 280000+47662,
    // cacheCreate 500000+130664, cacheRead 58000000+14435847,
    // totalTokens 63782000+15721982
    expect(d1.inputTokens).toBe(6109809);
    expect(d1.outputTokens).toBe(327662);
    expect(d1.cacheCreationTokens).toBe(630664);
    expect(d1.cacheReadTokens).toBe(72435847);
    expect(d1.totalTokens).toBe(79503982);
    const d2 = totals.get("2026-06-02")!;
    expect(d2.inputTokens).toBe(5828664);
    expect(d2.outputTokens).toBe(257702);
    expect(d2.cacheCreationTokens).toBe(0);
    expect(d2.cacheReadTokens).toBe(60834688);
    expect(d2.totalTokens).toBe(66921054);
  });

  test("hostIds subset restricts contributions (no dedup against excluded host)", async () => {
    const merged = await loadDuplicateDayDataset();
    const onlyA = combinedDailyTotals(merged, ["hostA"]);
    expect(onlyA.size).toBe(2);
    expect(onlyA.get("2026-06-01")!.cost).toBeCloseTo(125.5, 6);
    expect(onlyA.get("2026-06-02")!.cost).toBeCloseTo(60.25, 6);
    const onlyB = combinedDailyTotals(merged, ["hostB"]);
    expect(onlyB.get("2026-06-01")!.cost).toBeCloseTo(15.752521, 6);
    expect(onlyB.get("2026-06-02")!.cost).toBeCloseTo(34.445894, 6);
  });

  test("null/undefined hostIds = all hosts; unknown hostId = empty map", async () => {
    const merged = await loadDuplicateDayDataset();
    const viaNull = combinedDailyTotals(merged, null);
    const viaUndefined = combinedDailyTotals(merged, undefined);
    expect(viaNull.get("2026-06-01")!.cost).toBeCloseTo(141.252521, 6);
    expect(viaUndefined.get("2026-06-01")!.cost).toBeCloseTo(141.252521, 6);
    const none = combinedDailyTotals(merged, ["no-such-host"]);
    expect(none.size).toBe(0);
  });

  test("Map iterates in ascending date order even when input rows are unordered", () => {
    const mkRow = (date: DateString, cost: number): HostDailyRow => ({
      date,
      cost,
      totalTokens: 10,
      inputTokens: 10,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      agents: [],
      modelsUsed: [],
      modelBreakdowns: [],
    });
    const merged = mergeHosts([
      {
        host: makeHost("x"),
        snapshot: makeSnapshot(
          "x",
          { from: "2026-06-01", to: "2026-06-30" },
          makeData([mkRow("2026-06-10", 3), mkRow("2026-06-02", 1)]),
        ),
      },
      {
        host: makeHost("y"),
        snapshot: makeSnapshot(
          "y",
          { from: "2026-06-01", to: "2026-06-30" },
          makeData([mkRow("2026-06-05", 2)]),
        ),
      },
    ]);
    const totals = combinedDailyTotals(merged);
    expect([...totals.keys()]).toEqual([
      "2026-06-02",
      "2026-06-05",
      "2026-06-10",
    ]);
  });

  test("totalTokens is authoritative: merged total keeps the reported remainder", () => {
    // LIVE-VERIFIED quirk: totalTokens may EXCEED the sum of the 4 visible
    // classes (reasoning/other buckets). The merger must add reported values,
    // never recompute totalTokens from the classes.
    const row = (
      date: DateString,
      totalTokens: number,
      inputTokens: number,
    ): HostDailyRow => ({
      date,
      cost: 1,
      totalTokens,
      inputTokens,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      agents: [],
      modelsUsed: [],
      modelBreakdowns: [],
    });
    const merged = mergeHosts([
      {
        host: makeHost("x"),
        snapshot: makeSnapshot(
          "x",
          { from: "2026-06-01", to: "2026-06-30" },
          // classes sum to 900, reported total 1000 (remainder 100)
          makeData([row("2026-06-01", 1000, 900)]),
        ),
      },
      {
        host: makeHost("y"),
        snapshot: makeSnapshot(
          "y",
          { from: "2026-06-01", to: "2026-06-30" },
          makeData([row("2026-06-01", 500, 500)]),
        ),
      },
    ]);
    const d = combinedDailyTotals(merged).get("2026-06-01")!;
    expect(d.totalTokens).toBe(1500); // NOT 1400 (class-sum)
    expect(d.inputTokens).toBe(1400);
  });

  test("snapshot-less hosts contribute nothing and cause no crash", () => {
    const merged = mergeHosts([
      { host: makeHost("ghost"), snapshot: null },
    ]);
    const totals = combinedDailyTotals(merged);
    expect(totals.size).toBe(0);
  });

  test("output is NOT zero-filled: only dates present on some host appear", async () => {
    const rows = await loadUnifiedDailyRows("zero-usage-gaps.json");
    const merged = mergeHosts([
      {
        host: makeHost("gappy"),
        snapshot: makeSnapshot(
          "gappy",
          { from: "2026-06-01", to: "2026-06-28" },
          makeData(rows),
        ),
      },
    ]);
    const totals = combinedDailyTotals(merged);
    expect(totals.size).toBe(5);
    expect([...totals.keys()]).toEqual([
      "2026-06-02",
      "2026-06-09",
      "2026-06-10",
      "2026-06-20",
      "2026-06-27",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Zero-fill backbone: dateRangeInclusive x combinedDailyTotals over the
// zero-usage-gaps fixture (28-day window, 5 present, 23 zero-filled).
// ---------------------------------------------------------------------------

describe("zero-fill over zero-usage-gaps fixture", () => {
  async function gapsTotals(): Promise<Map<DateString, UsageTotals>> {
    const rows = await loadUnifiedDailyRows("zero-usage-gaps.json");
    const merged = mergeHosts([
      {
        host: makeHost("gappy"),
        snapshot: makeSnapshot(
          "gappy",
          { from: "2026-06-01", to: "2026-06-28" },
          makeData(rows),
        ),
      },
    ]);
    return combinedDailyTotals(merged);
  }

  test("28-day axis is continuous and inclusive of both boundaries", () => {
    const axis = dateRangeInclusive("2026-06-01", "2026-06-28");
    expect(axis.length).toBe(28);
    expect(axis[0]).toBe("2026-06-01");
    expect(axis[27]).toBe("2026-06-28");
    // Continuity: each date is exactly one day after the previous.
    for (let i = 1; i < axis.length; i++) {
      expect(diffDays(axis[i - 1]!, axis[i]!)).toBe(1);
    }
  });

  test("zero-filling the axis yields 5 usage days and 23 zero days, sum 52.909979", async () => {
    const totals = await gapsTotals();
    const axis = dateRangeInclusive("2026-06-01", "2026-06-28");
    const series = axis.map((d) => totals.get(d)?.cost ?? 0);
    expect(series.length).toBe(28);
    expect(series.filter((c) => c > 0).length).toBe(5);
    expect(series.filter((c) => c === 0).length).toBe(23);
    // jq: 12.34 + 27.87125 + 3.104999 + 9.500001 + 0.093729 = 52.909979
    const sum = series.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(52.909979, 6);
  });

  test("inclusive from/to filtering is plain date-string comparison (boundary rows kept)", async () => {
    const totals = await gapsTotals();
    // Sub-range whose endpoints land EXACTLY on usage days: 06-09 and 06-20
    // must both be included (FR6: from/to inclusive).
    const from = "2026-06-09";
    const to = "2026-06-20";
    const kept = [...totals.keys()].filter(
      (d) => compareDates(from, d) <= 0 && compareDates(d, to) <= 0,
    );
    expect(kept).toEqual(["2026-06-09", "2026-06-10", "2026-06-20"]);
    // jq for the same subset: 27.87125 + 3.104999 + 9.500001 = 40.47625
    const cost = kept.reduce((a, d) => a + totals.get(d)!.cost, 0);
    expect(cost).toBeCloseTo(40.47625, 6);
  });
});

// ---------------------------------------------------------------------------
// dates.ts — calendar string math, tz conversion, presets, previous period
// ---------------------------------------------------------------------------

describe("todayInTz", () => {
  test("America/Boise summer (MDT, UTC-6): day boundary at 06:00Z", () => {
    // 2026-07-02T05:59Z = 2026-07-01 23:59 MDT
    expect(todayInTz(TZ, new Date("2026-07-02T05:59:00Z"))).toBe("2026-07-01");
    // 2026-07-02T06:00Z = 2026-07-02 00:00 MDT
    expect(todayInTz(TZ, new Date("2026-07-02T06:00:00Z"))).toBe("2026-07-02");
  });

  test("America/Boise winter (MST, UTC-7): day boundary at 07:00Z", () => {
    expect(todayInTz(TZ, new Date("2026-01-15T06:59:00Z"))).toBe("2026-01-14");
    expect(todayInTz(TZ, new Date("2026-01-15T07:00:00Z"))).toBe("2026-01-15");
  });

  test("UTC and ahead-of-UTC zones", () => {
    expect(todayInTz("UTC", new Date("2026-07-02T00:00:00Z"))).toBe(
      "2026-07-02",
    );
    // Tokyo is UTC+9: 15:30Z is already the next day there.
    expect(todayInTz("Asia/Tokyo", new Date("2026-07-02T15:30:00Z"))).toBe(
      "2026-07-03",
    );
  });
});

describe("isValidDateString", () => {
  test("accepts real calendar dates incl. leap day", () => {
    expect(isValidDateString("2026-07-02")).toBe(true);
    expect(isValidDateString("2026-02-28")).toBe(true);
    expect(isValidDateString("2028-02-29")).toBe(true); // 2028 is a leap year
    expect(isValidDateString("2026-12-31")).toBe(true);
  });

  test("rejects impossible dates that match the regex", () => {
    expect(isValidDateString("2026-02-30")).toBe(false);
    expect(isValidDateString("2026-02-29")).toBe(false); // 2026 is NOT a leap year
    expect(isValidDateString("2026-04-31")).toBe(false); // April has 30 days
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(isValidDateString("2026-00-10")).toBe(false);
  });

  test("rejects wrong formats", () => {
    expect(isValidDateString("2026-6-1")).toBe(false);
    expect(isValidDateString("20260601")).toBe(false);
    expect(isValidDateString("2026/06/01")).toBe(false);
    expect(isValidDateString("2026-06-01T00:00:00Z")).toBe(false);
    expect(isValidDateString("")).toBe(false);
  });
});

describe("isValidTimezone", () => {
  test("accepts real IANA zones, rejects junk, never throws", () => {
    expect(isValidTimezone("America/Boise")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Asia/Tokyo")).toBe(true);
    expect(isValidTimezone("Mars/OlympusMons")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("not a tz!")).toBe(false);
  });
});

describe("addDays — pure calendar math", () => {
  test("month boundaries, both directions", () => {
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28"); // non-leap Feb
    expect(addDays("2026-07-02", 0)).toBe("2026-07-02");
  });

  test("leap-year February", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  test("year boundaries", () => {
    expect(addDays("2025-12-31", 1)).toBe("2026-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-07-02", -365)).toBe("2025-07-02"); // 2026 span has no Feb 29
  });

  test("crossing America/Boise DST transitions causes no drift (23h/25h days)", () => {
    // Spring forward: 2026-03-08 (second Sunday in March — a 23-hour local day).
    // Calendar math must be tz-free: exactly one date per step.
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-03-01", 14)).toBe("2026-03-15");
    // Fall back: 2026-11-01 (first Sunday in November — a 25-hour local day).
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
    expect(addDays("2026-10-25", 14)).toBe("2026-11-08"); // 25+14-31 = Nov 8
  });
});

describe("diffDays", () => {
  test("inclusive-range arithmetic basis: to - from", () => {
    expect(diffDays("2026-06-01", "2026-06-30")).toBe(29);
    expect(diffDays("2026-06-15", "2026-06-15")).toBe(0);
    expect(diffDays("2026-06-30", "2026-06-01")).toBe(-29);
  });

  test("across year boundary", () => {
    // Dec 25 -> Jan 5: 6 days left in Dec + 5 into Jan = 11
    expect(diffDays("2025-12-25", "2026-01-05")).toBe(11);
  });

  test("across DST transitions: whole days, no epoch-hour drift", () => {
    expect(diffDays("2026-03-07", "2026-03-09")).toBe(2); // spans 23h day
    expect(diffDays("2026-10-31", "2026-11-02")).toBe(2); // spans 25h day
    expect(diffDays("2026-03-01", "2026-04-01")).toBe(31);
  });
});

describe("compareDates / minDate / maxDate", () => {
  test("lexicographic compare is calendar-correct for YYYY-MM-DD", () => {
    expect(compareDates("2025-12-31", "2026-01-01")).toBeLessThan(0);
    expect(compareDates("2026-06-15", "2026-06-15")).toBe(0);
    expect(compareDates("2026-06-16", "2026-06-15")).toBeGreaterThan(0);
  });

  test("minDate / maxDate", () => {
    expect(minDate("2025-12-31", "2026-01-01")).toBe("2025-12-31");
    expect(maxDate("2025-12-31", "2026-01-01")).toBe("2026-01-01");
    expect(minDate("2026-06-15", "2026-06-15")).toBe("2026-06-15");
  });
});

describe("dateRangeInclusive", () => {
  test("both endpoints included, ascending", () => {
    expect(dateRangeInclusive("2026-06-01", "2026-06-03")).toEqual([
      "2026-06-01",
      "2026-06-02",
      "2026-06-03",
    ]);
  });

  test("single-day range and inverted range", () => {
    expect(dateRangeInclusive("2026-07-02", "2026-07-02")).toEqual([
      "2026-07-02",
    ]);
    expect(dateRangeInclusive("2026-07-02", "2026-07-01")).toEqual([]);
  });

  test("crosses month and year boundaries", () => {
    expect(dateRangeInclusive("2026-06-29", "2026-07-01")).toEqual([
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
    ]);
    expect(dateRangeInclusive("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });

  test("crosses DST transitions with each date exactly once", () => {
    expect(dateRangeInclusive("2026-03-07", "2026-03-10")).toEqual([
      "2026-03-07",
      "2026-03-08", // 23-hour day in America/Boise
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(dateRangeInclusive("2026-10-31", "2026-11-02")).toEqual([
      "2026-10-31",
      "2026-11-01", // 25-hour day in America/Boise
      "2026-11-02",
    ]);
  });

  test("length === diffDays + 1", () => {
    const axis = dateRangeInclusive("2026-04-04", "2026-07-02");
    expect(axis.length).toBe(diffDays("2026-04-04", "2026-07-02") + 1);
    expect(axis.length).toBe(90); // the 90d preset window
  });
});

describe("previousPeriod — equal length, adjacent, non-overlapping", () => {
  test("calendar month example from the spec", () => {
    expect(previousPeriod({ from: "2026-06-01", to: "2026-06-30" })).toEqual({
      from: "2026-05-02",
      to: "2026-05-31",
    });
  });

  test("30d window ending 2026-07-02 => prior 30d ending 2026-06-02", () => {
    // 30d preset from 2026-07-02: {2026-06-03..2026-07-02} (30 days).
    // Prior period of equal length: from = 2026-06-03 - 30d = 2026-05-04,
    // to = 2026-06-03 - 1d = 2026-06-02. Adjacent, no gap, no overlap.
    expect(previousPeriod({ from: "2026-06-03", to: "2026-07-02" })).toEqual({
      from: "2026-05-04",
      to: "2026-06-02",
    });
  });

  test("single-day range ('today' preset)", () => {
    expect(previousPeriod({ from: "2026-07-02", to: "2026-07-02" })).toEqual({
      from: "2026-07-01",
      to: "2026-07-01",
    });
  });

  test("invariants: equal length, adjacency, strictly earlier", () => {
    const range: DateRange = { from: "2026-06-26", to: "2026-07-02" }; // 7d
    const prev = previousPeriod(range);
    expect(prev).toEqual({ from: "2026-06-19", to: "2026-06-25" });
    // Equal length
    expect(diffDays(prev.from, prev.to)).toBe(diffDays(range.from, range.to));
    // Immediately preceding: prev.to is exactly the day before range.from
    expect(addDays(prev.to, 1)).toBe(range.from);
    // No overlap
    expect(compareDates(prev.to, range.from)).toBeLessThan(0);
  });

  test("crosses a month boundary backwards without drift", () => {
    // 14d range {2026-03-05..2026-03-18} => prev {2026-02-19..2026-03-04}
    // (2026 Feb has 28 days; from-14 = Mar 5 - 14 = Feb 19).
    expect(previousPeriod({ from: "2026-03-05", to: "2026-03-18" })).toEqual({
      from: "2026-02-19",
      to: "2026-03-04",
    });
  });
});

describe("resolvePreset (today = 2026-07-02)", () => {
  const today = "2026-07-02";

  test('"today" => single-day range', () => {
    expect(resolvePreset("today", today)).toEqual({ from: today, to: today });
  });

  test('"Nd" = today plus the N-1 preceding days (FR6 wire convention)', () => {
    // 7d: 2026-07-02 minus 6 days = 2026-06-26
    expect(resolvePreset("7d", today)).toEqual({
      from: "2026-06-26",
      to: today,
    });
    // 14d: minus 13 = 2026-06-19
    expect(resolvePreset("14d", today)).toEqual({
      from: "2026-06-19",
      to: today,
    });
    // 30d: minus 29 = 2026-06-03 (June has 30 days: Jul2 -29 -> Jun 3)
    expect(resolvePreset("30d", today)).toEqual({
      from: "2026-06-03",
      to: today,
    });
    // 60d: minus 59 = 2026-05-04 (27 left in May after the 4th + 30 Jun + 2 Jul = 59)
    expect(resolvePreset("60d", today)).toEqual({
      from: "2026-05-04",
      to: today,
    });
    // 90d: minus 89 = 2026-04-04 (day-of-year 183 - 89 = 94 = Apr 4, 2026 non-leap)
    expect(resolvePreset("90d", today)).toEqual({
      from: "2026-04-04",
      to: today,
    });
  });

  test("Nd ranges have exactly N dates", () => {
    const r7 = resolvePreset("7d", today);
    expect(dateRangeInclusive(r7.from, r7.to).length).toBe(7);
    const r30 = resolvePreset("30d", today);
    expect(dateRangeInclusive(r30.from, r30.to).length).toBe(30);
    const r90 = resolvePreset("90d", today);
    expect(dateRangeInclusive(r90.from, r90.to).length).toBe(90);
  });

  test('"mtd" => start of month through today; degenerate on the 1st', () => {
    expect(resolvePreset("mtd", today)).toEqual({
      from: "2026-07-01",
      to: today,
    });
    expect(resolvePreset("mtd", "2026-06-01")).toEqual({
      from: "2026-06-01",
      to: "2026-06-01",
    });
  });
});

describe("month helpers", () => {
  test("monthOf / dayOfMonth", () => {
    expect(monthOf("2026-06-15")).toBe("2026-06");
    expect(monthOf("2026-12-01")).toBe("2026-12");
    expect(dayOfMonth("2026-06-15")).toBe(15);
    expect(dayOfMonth("2026-06-01")).toBe(1);
    expect(dayOfMonth("2026-06-30")).toBe(30);
  });

  test("daysInMonth is leap-aware (incl. century rule)", () => {
    expect(daysInMonth("2028-02")).toBe(29); // divisible by 4
    expect(daysInMonth("2026-02")).toBe(28); // not divisible by 4
    expect(daysInMonth("2100-02")).toBe(28); // century, not divisible by 400
    expect(daysInMonth("2000-02")).toBe(29); // divisible by 400
    expect(daysInMonth("2026-06")).toBe(30);
    expect(daysInMonth("2026-07")).toBe(31);
    expect(daysInMonth("2026-12")).toBe(31);
  });

  test("startOfMonth / endOfMonth", () => {
    expect(startOfMonth("2026-06-15")).toBe("2026-06-01");
    expect(endOfMonth("2026-06-15")).toBe("2026-06-30");
    expect(endOfMonth("2026-07-02")).toBe("2026-07-31");
    expect(endOfMonth("2028-02-10")).toBe("2028-02-29"); // leap Feb
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28"); // non-leap Feb
    expect(startOfMonth("2026-01-01")).toBe("2026-01-01");
    expect(endOfMonth("2026-12-31")).toBe("2026-12-31");
  });

  test("monthToDateRange", () => {
    expect(monthToDateRange("2026-07-02")).toEqual({
      from: "2026-07-01",
      to: "2026-07-02",
    });
    expect(monthToDateRange("2026-06-01")).toEqual({
      from: "2026-06-01",
      to: "2026-06-01",
    });
  });
});

describe("isoToDateInTz", () => {
  test("spec example: just-past-midnight UTC lands on the PREVIOUS Boise day", () => {
    expect(isoToDateInTz("2026-06-11T00:11:07.884Z", TZ)).toBe("2026-06-10");
  });

  test("winter offset (MST, UTC-7)", () => {
    expect(isoToDateInTz("2026-01-15T06:30:00Z", TZ)).toBe("2026-01-14");
    expect(isoToDateInTz("2026-01-15T07:30:00Z", TZ)).toBe("2026-01-15");
  });

  test("on the spring-forward day itself", () => {
    // 2026-03-08T08:30Z = 01:30 MST, still 2026-03-08 locally.
    expect(isoToDateInTz("2026-03-08T08:30:00Z", TZ)).toBe("2026-03-08");
  });

  test("UTC passthrough", () => {
    expect(isoToDateInTz("2026-06-11T00:11:07.884Z", "UTC")).toBe("2026-06-11");
  });

  test("hostile input returns null, never throws", () => {
    expect(isoToDateInTz("not-a-timestamp", TZ)).toBeNull();
    expect(isoToDateInTz("", TZ)).toBeNull();
  });
});
