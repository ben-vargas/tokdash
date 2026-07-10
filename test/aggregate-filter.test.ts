/**
 * Tests for src/shared/aggregate.ts — computeUsage filtering + aggregation math.
 *
 * TDD red phase: the module under test currently throws "not implemented".
 *
 * EVERY expected number below was derived INDEPENDENTLY of the code under test,
 * with jq over the committed fixtures (derivations shown in comments) or by
 * hand-constructing minimal inputs with obvious arithmetic. Timezone is
 * America/Boise (tokdash.config.json); injected `today` is 2026-07-02.
 */

import { describe, expect, test } from "bun:test";

import type {
  AgentDailyRow,
  ComputeUsageOptions,
  DateRange,
  HostDailyRow,
  HostUsageData,
  MergedDataset,
  MergedHostData,
  ModelBreakdown,
  SessionRow,
  SessionTableRow,
  TokenCounts,
  UsageFilter,
} from "../src/shared/types";
import {
  addTotals,
  computeUsage,
  emptyUsageTotals,
  filterSessionRows,
  isRangeCovered,
  previousPeriodComparison,
  projectMonthEnd,
  resolveUsageFilter,
  sessionDateOf,
  topNModels,
  zeroFillSeries,
} from "../src/shared/aggregate";
import {
  OTHER_MODELS_KEY,
  OTHER_MODELS_LABEL,
  noModelDataKey,
} from "../src/shared/constants";

/* ================================================================== */
/* Test constants                                                      */
/* ================================================================== */

const TZ = "America/Boise";
const TODAY = "2026-07-02";
const OPTS: ComputeUsageOptions = { today: TODAY, timezone: TZ };

/** Fetch window of the unified fixtures captured on 2026-07-10. */
const REAL_WINDOW: DateRange = { from: "2026-04-11", to: "2026-07-10" };

/*
 * Derived with jq from fixtures/real/<host>/unified.json for the fixed window
 * 2026-06-25..2026-07-01 (7 calendar days):
 *   jq '[.daily[] | select(.period >= "2026-06-25" and .period <= "2026-07-01")]
 *       | {cost: (map(.totalCost)|add), input: (map(.inputTokens)|add), ...}'
 */
const LAPTOP_W_COST = 841.4703578499982; // 7 rows (every day present)
const WORKSTATION_W_COST = 256.19756140000004; // 4 rows: 06-28..07-01
const BUILDBOX_W_COST = 55.327930669999986; // 3 rows: 06-29..07-01
const COMBINED_W_COST = LAPTOP_W_COST + WORKSTATION_W_COST + BUILDBOX_W_COST;

// Combined token sums for the same window (plain addition of the jq per-host sums):
const COMBINED_W_INPUT = 11905724 + 9241865 + 3973160; // 25120749
const COMBINED_W_OUTPUT = 4482920 + 579549 + 142385; // 5204854
const COMBINED_W_CACHE_CREATE = 23390903 + 60393 + 4686; // 23455982
const COMBINED_W_CACHE_READ = 447747201 + 81976372 + 32945811; // 562669384
const COMBINED_W_TOTAL_TOKENS = 487526748 + 91858179 + 37096301; // 616481228

// Per-day combined costs in the window (jq group_by(.period) over the 3 files):
//   2026-06-25 → 1.847776 (laptop only; workstation starts 06-28, buildbox 06-29)
//   2026-06-29 → 152.18387025000004
//   2026-07-01 → 746.3380120999982   (max — mostExpensiveDay)
const DAY_0625_COMBINED = 1.847776;
const DAY_0629_COMBINED = 152.18387025000004;
const DAY_0701_COMBINED = 746.3380120999982;

// laptop's 2026-06-25 unified row (the only host active that day):
//   {totalCost: 4.61944, inputTokens: 273192, outputTokens: 4884,
//    cacheCreationTokens: 0, cacheReadTokens: 670592, totalTokens: 948668}
const DAY_0625_INPUT = 273192;
const DAY_0625_OUTPUT = 4884;
const DAY_0625_CACHE_CREATE = 0;
const DAY_0625_CACHE_READ = 670592;

// Previous period of 2026-06-25..2026-07-01 is 2026-06-18..2026-06-24.
const PREV_W_COMBINED_COST = 848.6039813500001;

/*
 * hermes (buildbox only) over 2026-06-01..2026-07-01, derived with jq from
 * unified.json's hermes slices:
 *   cost 69.99167116999999 across 9 active days;
 *   inputTokens 5597281, outputTokens 203913, cacheCreationTokens 0,
 *   cacheReadTokens 41599487, totalTokens 47444264.
 *   NOTE the live-verified quirk: totalTokens (47444264) is LARGER than the
 *   class sum 5597281+203913+0+41599487 = 47400681 — authoritative, never recompute.
 *   Max day: 2026-06-30 → 47.534014169999985. July MTD: 20.093358.
 *   Previous period of that 31-day range is 2026-05-01..2026-05-31:
 *   hermes May cost = 234.89320684999993.
 */
const HERMES_JUNE_COST = 69.99167116999999;
const HERMES_JUNE_TOTAL_TOKENS = 47444264;
const HERMES_JUNE_CLASS_SUM = 5597281 + 203913 + 0 + 41599487; // 47400681
const HERMES_MAX_DAY_COST = 47.534014169999985;
const HERMES_JULY_MTD = 20.093358;
const HERMES_MAY_COST = 234.89320684999993;

// July MTD for all hosts/agents with today = 2026-07-02 (MTD = 07-01..07-02
// inclusive). CORRECTION (verified against the fixtures with jq): the real
// daily fixtures DO contain 2026-07-02 rows — laptop 14.287603 and workstation 2.37266
// (buildbox has none) — so combined July MTD is NOT just the 07-01 day cost:
//   794.9833840999981 + 14.287603 + 2.37266 = 811.6436470999981
// (kpi-compare.test.ts's hand ledger confirms MTD includes today's rows.)
const COMBINED_JULY_MTD = 1320.2540432499975;

/* ================================================================== */
/* Row / dataset construction helpers (test-local, independent of src) */
/* ================================================================== */

function tokens(partial: Partial<TokenCounts> = {}): TokenCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    ...partial,
  };
}

function hostDailyRow(
  date: string,
  cost: number,
  extra: Partial<HostDailyRow> = {},
): HostDailyRow {
  return {
    date,
    cost,
    agents: [],
    modelsUsed: [],
    modelBreakdowns: [],
    ...tokens(),
    ...extra,
  };
}

function agentDailyRow(
  agent: string,
  sourceShape: string,
  date: string,
  cost: number,
  extra: Partial<AgentDailyRow> = {},
): AgentDailyRow {
  return {
    agent,
    date,
    cost,
    modelsUsed: [],
    modelBreakdowns: sourceShape === "hermes" ? null : [],
    messageCount: null,
    reasoningOutputTokens: null,
    dialect: "unified",
    ...tokens(),
    ...extra,
  };
}

function sessionRow(
  sessionId: string,
  agent: string,
  cost: number,
  lastActivity: string | null,
  extra: Partial<SessionRow> = {},
): SessionRow {
  return {
    sessionId,
    agent,
    cost,
    modelsUsed: [],
    modelBreakdowns: [],
    lastActivity,
    projectPath: null,
    ...tokens(),
    ...extra,
  };
}

function sessionTableRow(
  sessionId: string,
  projectPath: string | null,
  cost = 1,
): SessionTableRow {
  return {
    sessionId,
    hostId: "h",
    agent: "claude",
    models: [],
    lastActivity: null,
    projectPath,
    cost,
    ...tokens(),
  };
}

function mkHost(
  hostId: string,
  label: string,
  data: Partial<HostUsageData>,
  window: DateRange | null = REAL_WINDOW,
  overrides: Partial<MergedHostData> = {},
): MergedHostData {
  return {
    hostId,
    label,
    color: "#7c8cf8",
    enabled: true,
    data: {
      daily: [],
      monthly: [],
      sessions: [],
      agentDaily: {},
      agents: [],
      ...data,
    },
    fetchedAt: window ? "2026-07-02T00:00:00.000Z" : null,
    error: null,
    window,
    ...overrides,
  };
}

function mkDataset(
  hosts: MergedHostData[],
  coverage: DateRange | null,
): MergedDataset {
  const agents = [...new Set(hosts.flatMap((h) => h.data.agents))].sort();
  return { hosts, agents, coverage };
}

function allFilter(from: string, to: string): UsageFilter {
  return { from, to, hosts: null, agents: null };
}

/* ================================================================== */
/* Real-fixture loading (raw JSON mapped by TEST code, not by src/)    */
/* ================================================================== */

interface RawUnifiedDailyRow {
  period: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  metadata?: { agents?: string[] } | null;
  modelsUsed?: string[];
  modelBreakdowns?: ModelBreakdown[];
  agents?: RawAgentSlice[];
}

interface RawAgentSlice {
  agent: string;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
}

async function loadFixture<T>(rel: string): Promise<T> {
  return (await Bun.file(`${import.meta.dir}/../fixtures/${rel}`).json()) as T;
}

/** Map a raw unified daily row to the normalized HostDailyRow shape ourselves. */
function mapUnifiedRow(raw: RawUnifiedDailyRow): HostDailyRow {
  return {
    date: raw.period,
    cost: raw.totalCost,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cacheCreationTokens: raw.cacheCreationTokens,
    cacheReadTokens: raw.cacheReadTokens,
    totalTokens: raw.totalTokens,
    agents: raw.metadata?.agents ?? [],
    modelsUsed: raw.modelsUsed ?? [],
    modelBreakdowns: raw.modelBreakdowns ?? [],
  };
}

function mapAgentSlice(raw: RawAgentSlice, date: string): AgentDailyRow {
  return {
    agent: raw.agent,
    date,
    cost: raw.totalCost,
    inputTokens: raw.inputTokens,
    outputTokens: raw.outputTokens,
    cacheCreationTokens: raw.cacheCreationTokens,
    cacheReadTokens: raw.cacheReadTokens,
    totalTokens: raw.totalTokens,
    modelsUsed: raw.modelsUsed,
    modelBreakdowns: raw.modelBreakdowns,
    messageCount: null,
    reasoningOutputTokens: null,
    dialect: "unified",
  };
}

const laptopDailyRaw = await loadFixture<{ daily: RawUnifiedDailyRow[] }>(
  "real/laptop/unified.json",
);
const workstationDailyRaw = await loadFixture<{ daily: RawUnifiedDailyRow[] }>(
  "real/workstation/unified.json",
);
const buildboxDailyRaw = await loadFixture<{ daily: RawUnifiedDailyRow[] }>(
  "real/buildbox/unified.json",
);
const hugeCacheReadRaw = await loadFixture<{ daily: RawUnifiedDailyRow[] }>(
  "synthetic/huge-cache-read.json",
);
const emptyDataRaw = await loadFixture<{ daily: RawUnifiedDailyRow[] }>(
  "synthetic/empty-data.json",
);

function mappedAgentDaily(rows: RawUnifiedDailyRow[]): Record<string, AgentDailyRow[]> {
  const result: Record<string, AgentDailyRow[]> = {};
  for (const row of rows) {
    for (const slice of row.agents ?? []) {
      (result[slice.agent] ??= []).push(mapAgentSlice(slice, row.period));
    }
  }
  return result;
}

/** The three real hosts, with agentDaily derived from unified slices. */
function realDataset(): MergedDataset {
  return mkDataset(
    [
      mkHost("laptop", "Laptop", {
        daily: laptopDailyRaw.daily.map(mapUnifiedRow),
        agentDaily: mappedAgentDaily(laptopDailyRaw.daily),
        agents: ["claude", "codex", "droid", "omp", "opencode", "pi"],
      }),
      mkHost("workstation", "Workstation", {
        daily: workstationDailyRaw.daily.map(mapUnifiedRow),
        agentDaily: mappedAgentDaily(workstationDailyRaw.daily),
        agents: ["claude", "codex", "droid", "opencode", "pi"],
      }),
      mkHost("buildbox", "Build box", {
        daily: buildboxDailyRaw.daily.map(mapUnifiedRow),
        agentDaily: mappedAgentDaily(buildboxDailyRaw.daily),
        agents: ["claude", "codex", "gemini", "hermes", "pi"],
      }),
    ],
    REAL_WINDOW,
  );
}

const ALL_REAL_AGENTS = [
  "claude",
  "codex",
  "droid",
  "gemini",
  "hermes",
  "omp",
  "opencode",
  "pi",
];

/* ================================================================== */
/* resolveUsageFilter                                                  */
/* ================================================================== */

describe("resolveUsageFilter", () => {
  test("empty query defaults to the 30d preset ending today, all hosts/agents", () => {
    const r = resolveUsageFilter({}, TODAY);
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    // 30d default = today plus the 29 preceding days: 2026-07-02 − 29d = 2026-06-03
    expect(r.filter.from).toBe("2026-06-03");
    expect(r.filter.to).toBe("2026-07-02");
    expect(r.filter.hosts).toBeNull();
    expect(r.filter.agents).toBeNull();
  });

  test("explicit from/to pass through unchanged", () => {
    const r = resolveUsageFilter({ from: "2026-06-01", to: "2026-06-30" }, TODAY);
    if (!r.ok) throw new Error(r.error);
    expect(r.filter.from).toBe("2026-06-01");
    expect(r.filter.to).toBe("2026-06-30");
  });

  test("malformed date format is an error, not a throw", () => {
    expect(resolveUsageFilter({ from: "06/01/2026" }, TODAY).ok).toBe(false);
    expect(resolveUsageFilter({ from: "2026-6-1" }, TODAY).ok).toBe(false);
    expect(resolveUsageFilter({ to: "20260601" }, TODAY).ok).toBe(false);
  });

  test("non-real calendar date (2026-02-30) is rejected", () => {
    expect(resolveUsageFilter({ from: "2026-02-30" }, TODAY).ok).toBe(false);
  });

  test("from > to is an error", () => {
    const r = resolveUsageFilter({ from: "2026-06-10", to: "2026-06-01" }, TODAY);
    expect(r.ok).toBe(false);
  });

  test("hosts list: trimmed, empties dropped, duplicates removed, order kept", () => {
    const r = resolveUsageFilter({ hosts: " laptop , workstation ,,laptop " }, TODAY);
    if (!r.ok) throw new Error(r.error);
    expect(r.filter.hosts).toEqual(["laptop", "workstation"]);
  });

  test("empty / whitespace-only hosts and agents params mean all (null)", () => {
    const r1 = resolveUsageFilter({ hosts: "" }, TODAY);
    if (!r1.ok) throw new Error(r1.error);
    expect(r1.filter.hosts).toBeNull();
    const r2 = resolveUsageFilter({ agents: "  ,  " }, TODAY);
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.filter.agents).toBeNull();
  });

  test("unknown host/agent ids are NOT an error here", () => {
    const r = resolveUsageFilter({ hosts: "nope", agents: "warpspeed" }, TODAY);
    if (!r.ok) throw new Error(r.error);
    expect(r.filter.hosts).toEqual(["nope"]);
    expect(r.filter.agents).toEqual(["warpspeed"]);
  });

  test("a future 'to' is clamped to today (no data exists after today)", () => {
    const r = resolveUsageFilter({ from: "2026-06-01", to: "2027-01-01" }, TODAY);
    if (!r.ok) throw new Error(r.error);
    expect(r.filter.from).toBe("2026-06-01");
    expect(r.filter.to).toBe(TODAY);
    // an all-future range collapses to from > clamped-to => error, not a
    // giant empty axis
    expect(resolveUsageFilter({ from: "2027-06-01", to: "2027-06-30" }, TODAY).ok).toBe(false);
  });

  test("'from' before 2000-01-01 is rejected — one bookmarked 0001-01-01 URL must not OOM the server", () => {
    // Regression: from=0001-01-01&to=9999-12-31 used to materialize a
    // ~2.96M-entry zero-filled axis × 5 chart series (RSS 0.5GB → 12.8GB,
    // event loop blocked >10s, request died with RangeError: Out of memory).
    const r = resolveUsageFilter({ from: "0001-01-01", to: "9999-12-31" }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("2000-01-01");
    // also kills the Date.UTC two-digit-year axis inconsistency (year < 100)
    expect(resolveUsageFilter({ from: "0099-12-31" }, TODAY).ok).toBe(false);
    expect(resolveUsageFilter({ from: "1999-12-31" }, TODAY).ok).toBe(false);
  });

  test("spans over 3660 days are rejected; decade-scale sane ranges still pass", () => {
    const tooWide = resolveUsageFilter({ from: "2000-01-02", to: TODAY }, TODAY);
    expect(tooWide.ok).toBe(false);
    if (!tooWide.ok) expect(tooWide.error).toContain("3660");
    const ok = resolveUsageFilter({ from: "2020-01-01", to: TODAY }, TODAY); // 2375 days
    expect(ok.ok).toBe(true);
  });
});

/* ================================================================== */
/* Arithmetic / KPI helpers                                            */
/* ================================================================== */

describe("aggregation helpers", () => {
  test("addTotals sums field-by-field in full precision and returns a new object", () => {
    const a = {
      ...tokens({ inputTokens: 1, outputTokens: 2, cacheCreationTokens: 3, cacheReadTokens: 4, totalTokens: 11 }),
      cost: 82.06393750000001,
    };
    const b = {
      ...tokens({ inputTokens: 10, outputTokens: 20, cacheCreationTokens: 30, cacheReadTokens: 40, totalTokens: 111 }),
      cost: 39.6598589700001,
    };
    const sum = addTotals(a, b);
    expect(sum.cost).toBeCloseTo(121.72379647000011, 10);
    expect(sum.inputTokens).toBe(11);
    expect(sum.outputTokens).toBe(22);
    expect(sum.cacheCreationTokens).toBe(33);
    expect(sum.cacheReadTokens).toBe(44);
    expect(sum.totalTokens).toBe(122);
    expect(sum).not.toBe(a);
    expect(a.cost).toBeCloseTo(82.06393750000001, 10); // input untouched
  });

  test("zeroFillSeries produces one entry per axis date, in axis order", () => {
    const axis = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04"];
    const byDate = new Map<string, number>([
      ["2026-06-02", 5],
      ["2026-06-04", 9],
    ]);
    const out = zeroFillSeries(axis, byDate, () => 0);
    expect(out).toEqual([0, 5, 0, 9]);
  });

  test("zeroFillSeries passes the missing date to the empty() factory", () => {
    const axis = ["2026-06-01", "2026-06-02"];
    const out = zeroFillSeries(axis, new Map<string, string>(), (d) => `empty:${d}`);
    expect(out).toEqual(["empty:2026-06-01", "empty:2026-06-02"]);
  });

  test("previousPeriodComparison computes fraction deltas", () => {
    const c = previousPeriodComparison(115, 100);
    expect(c.previousValue).toBe(100);
    expect(c.deltaAbsolute).toBe(15);
    expect(c.deltaPercent).toBeCloseTo(0.15, 12);
    const down = previousPeriodComparison(0, 100);
    expect(down.deltaAbsolute).toBe(-100);
    expect(down.deltaPercent).toBeCloseTo(-1, 12);
  });

  test("previousPeriodComparison: deltaPercent is null when previous is 0", () => {
    const c = previousPeriodComparison(50, 0);
    expect(c.previousValue).toBe(0);
    expect(c.deltaAbsolute).toBe(50);
    expect(c.deltaPercent).toBeNull();
  });

  test("isRangeCovered: inclusive containment; null coverage is never covered", () => {
    const range = { from: "2026-06-01", to: "2026-06-30" };
    expect(isRangeCovered(range, null)).toBe(false);
    expect(isRangeCovered(range, { from: "2026-06-01", to: "2026-06-30" })).toBe(true);
    expect(isRangeCovered(range, { from: "2026-04-01", to: "2026-07-01" })).toBe(true);
    expect(isRangeCovered(range, { from: "2026-06-02", to: "2026-07-01" })).toBe(false);
    expect(isRangeCovered(range, { from: "2026-04-01", to: "2026-06-29" })).toBe(false);
  });

  test("projectMonthEnd: naive linear projection in full precision", () => {
    // 310 spent by end of day 2 of a 31-day month → 310 / 2 * 31 = 4805
    const p = projectMonthEnd(310, "2026-07-02");
    expect(p.month).toBe("2026-07");
    expect(p.daysElapsed).toBe(2);
    expect(p.daysInMonth).toBe(31);
    expect(p.monthToDateCost).toBe(310);
    expect(p.projectedCost).toBeCloseTo(4805, 10);
  });

  test("projectMonthEnd: day 1 never divides by zero; leap February has 29 days", () => {
    const first = projectMonthEnd(0, "2026-02-01");
    expect(first.daysElapsed).toBe(1);
    expect(first.daysInMonth).toBe(28);
    expect(first.projectedCost).toBe(0);
    const leap = projectMonthEnd(29, "2028-02-10");
    expect(leap.daysInMonth).toBe(29);
    expect(leap.projectedCost).toBeCloseTo((29 / 10) * 29, 10);
  });

  test("topNModels: cost desc, ties broken by name asc, disjoint and covering", () => {
    const costs = new Map<string, number>([
      ["b-model", 5],
      ["a-model", 5],
      ["c-model", 9],
    ]);
    const { top, other } = topNModels(costs, 2);
    expect(top).toEqual(["c-model", "a-model"]);
    expect(other).toEqual(["b-model"]);
  });

  test("topNModels: n defaults to 8", () => {
    const costs = new Map<string, number>();
    for (let i = 0; i < 10; i++) costs.set(`m${String(i).padStart(2, "0")}`, 100 - i);
    const { top, other } = topNModels(costs);
    expect(top.length).toBe(8);
    expect(other.length).toBe(2);
    expect(top).toEqual(["m00", "m01", "m02", "m03", "m04", "m05", "m06", "m07"]);
    expect([...top, ...other].sort()).toEqual([...costs.keys()].sort());
  });

  test("topNModels: zero-cost models still count as models", () => {
    const { top, other } = topNModels(new Map([["free-model", 0]]), 8);
    expect(top).toEqual(["free-model"]);
    expect(other).toEqual([]);
  });
});

/* ================================================================== */
/* sessionDateOf                                                       */
/* ================================================================== */

describe("sessionDateOf", () => {
  test("uses lastActivity converted to the config tz (UTC midnight is previous Boise day)", () => {
    // 2026-06-11T00:11Z is 2026-06-10 18:11 in America/Boise (UTC-6, MDT)
    const row = sessionRow("019d9062-aaaa", "pi", 1, "2026-06-11T00:11:07.884Z");
    expect(sessionDateOf(row, TZ)).toBe("2026-06-10");
  });

  test("falls back to hermes YYYYMMDD_HHMMSS_hex session-id prefix", () => {
    const row = sessionRow("20260426_192827_e498f7", "hermes", 1, null);
    expect(sessionDateOf(row, TZ)).toBe("2026-04-26");
  });

  test("falls back to codex YYYY/MM/DD/ path-prefix session id", () => {
    const row = sessionRow(
      "2026/04/27/rollout-2026-04-27T10-15-00-abc",
      "codex",
      1,
      null,
    );
    expect(sessionDateOf(row, TZ)).toBe("2026-04-27");
  });

  test("returns null (never throws) on undateable ids", () => {
    expect(sessionDateOf(sessionRow("019d9062-3234-70a7", "claude", 1, null), TZ)).toBeNull();
    expect(sessionDateOf(sessionRow("", "claude", 1, null), TZ)).toBeNull();
    expect(sessionDateOf(sessionRow("not/a/date/anything", "claude", 1, "garbage-iso"), TZ)).toBeNull();
  });
});

/* ================================================================== */
/* filterSessionRows (client-side text search)                         */
/* ================================================================== */

describe("filterSessionRows", () => {
  const rows = [
    sessionTableRow("20260426_192827_e498f7", null),
    sessionTableRow("019d9062-3234-70a7", "/Users/ben/projects/TokDash"),
    sessionTableRow("2026/04/27/rollout-abc", "/tmp/scratch"),
  ];

  test("case-insensitive substring over sessionId", () => {
    const hit = filterSessionRows(rows, "E498F7");
    expect(hit.length).toBe(1);
    expect(hit[0]!.sessionId).toBe("20260426_192827_e498f7");
  });

  test("case-insensitive substring over projectPath; null path matches nothing", () => {
    const hit = filterSessionRows(rows, "tokdash");
    expect(hit.length).toBe(1);
    expect(hit[0]!.sessionId).toBe("019d9062-3234-70a7");
    expect(filterSessionRows(rows, "no-such-thing").length).toBe(0);
  });

  test("empty and whitespace-only queries return rows unchanged", () => {
    expect(filterSessionRows(rows, "")).toEqual(rows);
    expect(filterSessionRows(rows, "   ")).toEqual(rows);
  });
});

/* ================================================================== */
/* computeUsage — real fixtures, all hosts + all agents (exact unified)*/
/* ================================================================== */

describe("computeUsage: real fixtures, all hosts/agents, 2026-06-25..2026-07-01", () => {
  const filter = allFilter("2026-06-25", "2026-07-01");
  const run = () => computeUsage(realDataset(), filter, OPTS);

  test("dateAxis is the continuous inclusive 7-day range", () => {
    const r = run();
    expect(r.dateAxis.length).toBe(7);
    expect(r.dateAxis[0]).toBe("2026-06-25");
    expect(r.dateAxis[6]).toBe("2026-07-01");
    expect(r.dateAxis).toEqual([
      "2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28",
      "2026-06-29", "2026-06-30", "2026-07-01",
    ]);
  });

  test("totals come from unified daily rows (authoritative), full precision", () => {
    const t = run().totals;
    expect(t.cost).toBeCloseTo(COMBINED_W_COST, 6);
    expect(t.inputTokens).toBe(COMBINED_W_INPUT);
    expect(t.outputTokens).toBe(COMBINED_W_OUTPUT);
    expect(t.cacheCreationTokens).toBe(COMBINED_W_CACHE_CREATE);
    expect(t.cacheReadTokens).toBe(COMBINED_W_CACHE_READ);
    // totalTokens is the verbatim reported value — NOT the class sum
    expect(t.totalTokens).toBe(COMBINED_W_TOTAL_TOKENS);
  });

  test("resolved filter: allHosts/allAgents true with concrete id lists", () => {
    const f = run().filter;
    expect(f.allHosts).toBe(true);
    expect(f.allAgents).toBe(true);
    expect([...f.hosts].sort()).toEqual(["buildbox", "laptop", "workstation"]);
    expect([...f.agents].sort()).toEqual(ALL_REAL_AGENTS);
    expect(f.from).toBe("2026-06-25");
    expect(f.to).toBe("2026-07-01");
  });

  test("echoes timezone and defaults generatedAt to today at UTC midnight", () => {
    const r = run();
    expect(r.timezone).toBe(TZ);
    expect(r.generatedAt).toBe("2026-07-02T00:00:00.000Z");
  });

  test("KPIs: total, calendar-day average, active days", () => {
    const k = run().kpis;
    expect(k.totalCost.value).toBeCloseTo(COMBINED_W_COST, 6);
    expect(k.totalTokens.value).toBe(COMBINED_W_TOTAL_TOKENS);
    // divides by CALENDAR days (7), not active rows
    expect(k.dailyAverageCost.value).toBeCloseTo(COMBINED_W_COST / 7, 6);
    expect(k.activeDays.value).toBe(7); // laptop has usage every day of the window
  });

  test("KPI comparison vs the fully-covered previous period 2026-06-18..2026-06-24", () => {
    const k = run().kpis;
    const cmp = k.totalCost.comparison;
    expect(k.totalCost.comparisonUnavailableReason).toBeNull();
    expect(cmp).not.toBeNull();
    expect(cmp!.previousValue).toBeCloseTo(PREV_W_COMBINED_COST, 6);
    expect(cmp!.deltaAbsolute).toBeCloseTo(COMBINED_W_COST - PREV_W_COMBINED_COST, 6);
    expect(cmp!.deltaPercent).toBeCloseTo(
      (COMBINED_W_COST - PREV_W_COMBINED_COST) / PREV_W_COMBINED_COST,
      9,
    );
  });

  test("mostExpensiveDay is 2026-07-01", () => {
    const med = run().kpis.mostExpensiveDay;
    expect(med).not.toBeNull();
    expect(med!.date).toBe("2026-07-01");
    expect(med!.cost).toBeCloseTo(DAY_0701_COMBINED, 6);
  });

  test("projectedMonthEnd uses July MTD (independent of from/to) in config tz", () => {
    const p = run().kpis.projectedMonthEnd;
    expect(p).not.toBeNull();
    expect(p!.month).toBe("2026-07");
    expect(p!.daysElapsed).toBe(2); // today = 2026-07-02
    expect(p!.daysInMonth).toBe(31);
    expect(p!.monthToDateCost).toBeCloseTo(COMBINED_JULY_MTD, 6);
    expect(p!.projectedCost).toBeCloseTo((COMBINED_JULY_MTD / 2) * 31, 6);
  });

  test("host stacked series: exact, zero-filled, every point carries every key", () => {
    const s = run().charts.dailyCostByHost;
    expect(s.dimension).toBe("host");
    expect(s.exact).toBe(true);
    expect(s.points.length).toBe(7);
    const ids = s.keys.map((k) => k.id).sort();
    expect(ids).toEqual(["buildbox", "laptop", "workstation"]);
    for (const k of s.keys) expect(k.kind).toBe("host");
    const byId = new Map(s.keys.map((k) => [k.id, k]));
    expect(byId.get("laptop")!.label).toBe("Laptop");
    // 2026-06-25: only laptop has usage; workstation/buildbox zero-filled on the point
    const p0 = s.points[0]!;
    expect(p0.date).toBe("2026-06-25");
    expect(p0.values["laptop"]).toBeCloseTo(DAY_0625_COMBINED, 6);
    expect(p0.values["workstation"]).toBe(0);
    expect(p0.values["buildbox"]).toBe(0);
    expect(p0.total).toBeCloseTo(DAY_0625_COMBINED, 6);
    // 2026-06-29: all three hosts contribute
    const p4 = s.points[4]!;
    expect(p4.date).toBe("2026-06-29");
    expect(p4.total).toBeCloseTo(DAY_0629_COMBINED, 6);
  });

  test("model stack with all agents is exact:true with no note", () => {
    const s = run().charts.dailyCostByModel;
    expect(s.exact).toBe(true);
    expect(s.note).toBeNull();
  });

  test("cumulative cost: monotone, combined === sum(byHost), ends at the window total", () => {
    const c = run().charts.cumulativeCost;
    expect(c.points.length).toBe(7);
    let prev = -1;
    for (const p of c.points) {
      expect(p.combined).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = p.combined;
      const hostSum = Object.values(p.byHost).reduce((a, b) => a + b, 0);
      expect(p.combined).toBeCloseTo(hostSum, 6);
    }
    expect(c.points[6]!.combined).toBeCloseTo(COMBINED_W_COST, 6);
    expect(c.points[6]!.byHost["laptop"]).toBeCloseTo(LAPTOP_W_COST, 6);
    expect(c.points[6]!.byHost["workstation"]).toBeCloseTo(WORKSTATION_W_COST, 6);
    expect(c.points[6]!.byHost["buildbox"]).toBeCloseTo(BUILDBOX_W_COST, 6);
  });

  test("token composition: laptop-only 2026-06-25 shows that day's four classes", () => {
    const tc = run().charts.tokenComposition;
    expect(tc.points.length).toBe(7);
    const p0 = tc.points[0]!;
    expect(p0.date).toBe("2026-06-25");
    expect(p0.inputTokens).toBe(DAY_0625_INPUT);
    expect(p0.outputTokens).toBe(DAY_0625_OUTPUT);
    expect(p0.cacheCreationTokens).toBe(DAY_0625_CACHE_CREATE);
    expect(p0.cacheReadTokens).toBe(DAY_0625_CACHE_READ);
  });

  test("byHost breakdown: cost desc, shares are fractions of total, sparkline on axis", () => {
    const rows = run().tables.byHost;
    expect(rows.map((r) => r.key)).toEqual(["laptop", "workstation", "buildbox"]);
    expect(rows[0]!.cost).toBeCloseTo(LAPTOP_W_COST, 6);
    expect(rows[1]!.cost).toBeCloseTo(WORKSTATION_W_COST, 6);
    expect(rows[2]!.cost).toBeCloseTo(BUILDBOX_W_COST, 6);
    expect(rows[0]!.share).toBeCloseTo(LAPTOP_W_COST / COMBINED_W_COST, 9);
    expect(rows[2]!.share).toBeCloseTo(BUILDBOX_W_COST / COMBINED_W_COST, 9);
    const shareSum = rows.reduce((a, r) => a + r.share, 0);
    expect(shareSum).toBeCloseTo(1, 9);
    for (const r of rows) {
      expect(r.sparkline.length).toBe(7);
      const sparkSum = r.sparkline.reduce((a, b) => a + b, 0);
      expect(sparkSum).toBeCloseTo(r.cost, 6);
    }
    // sparkline aligns with the axis: workstation has no usage before 2026-06-28
    expect(rows[1]!.sparkline[0]).toBe(0);
    expect(rows[1]!.sparkline[1]).toBe(0);
    expect(rows[1]!.sparkline[2]).toBe(0);
  });

  test("availableHosts lists ALL configured hosts; availableAgents sorted asc", () => {
    const r = run();
    expect(r.availableHosts.map((h) => h.id)).toEqual(["laptop", "workstation", "buildbox"]);
    expect(r.availableHosts[0]!.label).toBe("Laptop");
    expect(r.availableAgents).toEqual(ALL_REAL_AGENTS);
  });
});

/* ================================================================== */
/* computeUsage — host subset filtering                                */
/* ================================================================== */

describe("computeUsage: host subset filters (real fixtures)", () => {
  const window = { from: "2026-06-25", to: "2026-07-01" };

  test("hosts=[laptop] restricts totals to laptop's unified daily", () => {
    const r = computeUsage(
      realDataset(),
      { ...window, hosts: ["laptop"], agents: null },
      OPTS,
    );
    expect(r.totals.cost).toBeCloseTo(LAPTOP_W_COST, 6);
    expect(r.filter.allHosts).toBe(false);
    expect(r.filter.hosts).toEqual(["laptop"]);
  });

  test("hosts=[workstation,buildbox] adds exactly those two hosts", () => {
    const r = computeUsage(
      realDataset(),
      { ...window, hosts: ["workstation", "buildbox"], agents: null },
      OPTS,
    );
    expect(r.totals.cost).toBeCloseTo(WORKSTATION_W_COST + BUILDBOX_W_COST, 6);
  });

  test("an unknown host id resolves to an empty intersection → all-zero response", () => {
    const r = computeUsage(
      realDataset(),
      { ...window, hosts: ["ghost"], agents: null },
      OPTS,
    );
    expect(r.filter.hosts).toEqual([]);
    expect(r.filter.allHosts).toBe(false);
    expect(r.totals.cost).toBe(0);
    expect(r.kpis.activeDays.value).toBe(0);
    expect(Number.isFinite(r.kpis.dailyAverageCost.value)).toBe(true);
    expect(r.kpis.dailyAverageCost.value).toBe(0);
    expect(r.kpis.mostExpensiveDay).toBeNull();
    expect(r.tables.sessions).toEqual([]);
    expect(r.dateAxis.length).toBe(7); // axis still zero-filled
    for (const p of r.charts.dailyCostByHost.points) expect(p.total).toBe(0);
  });

  test("disabled hosts are excluded even when data is present", () => {
    const ds = mkDataset(
      [
        mkHost("on", "On", {
          daily: [hostDailyRow("2026-06-10", 10, { totalTokens: 100 })],
          agents: ["claude"],
        }),
        mkHost(
          "off",
          "Off",
          {
            daily: [hostDailyRow("2026-06-10", 99, { totalTokens: 900 })],
            agents: ["claude"],
          },
          REAL_WINDOW,
          { enabled: false },
        ),
      ],
      REAL_WINDOW,
    );
    const r = computeUsage(ds, allFilter("2026-06-01", "2026-06-30"), OPTS);
    expect(r.totals.cost).toBeCloseTo(10, 9);
    expect(r.filter.hosts).toEqual(["on"]);
  });
});

/* ================================================================== */
/* computeUsage — harness subset (exact per-agent dailies, FR1/FR3)    */
/* ================================================================== */

describe("computeUsage: agents=[hermes] over 2026-06-01..2026-07-01 (real fixtures)", () => {
  const filter: UsageFilter = {
    from: "2026-06-01",
    to: "2026-07-01",
    hosts: null,
    agents: ["hermes"],
  };
  const run = () => computeUsage(realDataset(), filter, OPTS);

  test("totals come from buildbox's hermes agent-daily rows; laptop+workstation contribute $0", () => {
    const t = run().totals;
    // jq over buildbox unified daily hermes slices, dates 06-01..07-01
    expect(t.cost).toBeCloseTo(HERMES_JUNE_COST, 6); // ≈ the $55.05 anchor
    expect(t.inputTokens).toBe(5597281);
    expect(t.outputTokens).toBe(203913);
    expect(t.cacheCreationTokens).toBe(0);
    expect(t.cacheReadTokens).toBe(41599487);
  });

  test("totalTokens stays the authoritative reported value, larger than the class sum", () => {
    const t = run().totals;
    expect(t.totalTokens).toBe(HERMES_JUNE_TOTAL_TOKENS);
    expect(t.totalTokens).toBeGreaterThan(HERMES_JUNE_CLASS_SUM); // 47444264 > 47400681
  });

  test("filter resolution: allAgents false, agents=[hermes]", () => {
    const f = run().filter;
    expect(f.allAgents).toBe(false);
    expect(f.agents).toEqual(["hermes"]);
    expect(f.allHosts).toBe(true);
  });

  test("KPIs: 9 active days over a 31-day axis; mostExpensiveDay 2026-06-30", () => {
    const r = run();
    expect(r.dateAxis.length).toBe(31);
    expect(r.kpis.activeDays.value).toBe(9);
    expect(r.kpis.dailyAverageCost.value).toBeCloseTo(HERMES_JUNE_COST / 31, 6);
    expect(r.kpis.mostExpensiveDay!.date).toBe("2026-06-30");
    expect(r.kpis.mostExpensiveDay!.cost).toBeCloseTo(HERMES_MAX_DAY_COST, 6);
    expect(r.kpis.topHarness).toEqual(
      expect.objectContaining({ agent: "hermes" }),
    );
  });

  test("comparison vs prior 31 days (2026-05-01..2026-05-31) uses hermes May data", () => {
    const cmp = run().kpis.totalCost.comparison;
    expect(cmp).not.toBeNull();
    expect(cmp!.previousValue).toBeCloseTo(HERMES_MAY_COST, 6);
    expect(cmp!.deltaPercent).toBeCloseTo(
      (HERMES_JUNE_COST - HERMES_MAY_COST) / HERMES_MAY_COST,
      9,
    );
  });

  test("projectedMonthEnd under the hermes filter uses hermes-only July MTD", () => {
    const p = run().kpis.projectedMonthEnd;
    expect(p).not.toBeNull();
    expect(p!.monthToDateCost).toBeCloseTo(HERMES_JULY_MTD, 9);
    expect(p!.projectedCost).toBeCloseTo((HERMES_JULY_MTD / 2) * 31, 9);
  });

  test("host stack keeps only buildbox (all-zero laptop/workstation keys omitted)", () => {
    const s = run().charts.dailyCostByHost;
    expect(s.keys.map((k) => k.id)).toEqual(["buildbox"]);
    const total = s.points.reduce((a, p) => a + p.total, 0);
    expect(total).toBeCloseTo(HERMES_JUNE_COST, 6);
  });

  test("FR3 subset mode uses hermes slice breakdowns with real costs", () => {
    const s = run().charts.dailyCostByModel;
    expect(s.exact).toBe(false);
    expect(typeof s.note).toBe("string");
    expect(s.note!.length).toBeGreaterThan(0);
    expect(s.keys.some((k) => k.id === noModelDataKey("hermes"))).toBe(false);
    expect(s.keys.map((k) => k.id)).toContain("gpt-5.5");
    expect(s.points.reduce((sum, point) => sum + point.total, 0)).toBeCloseTo(
      HERMES_JUNE_COST,
      6,
    );
  });

  test("byHarness table: a single hermes row with share 1", () => {
    const rows = run().tables.byHarness;
    expect(rows.length).toBe(1);
    expect(rows[0]!.key).toBe("hermes");
    expect(rows[0]!.cost).toBeCloseTo(HERMES_JUNE_COST, 6);
    expect(rows[0]!.share).toBeCloseTo(1, 9);
    expect(rows[0]!.sparkline.length).toBe(31);
  });
});

/* ================================================================== */
/* computeUsage — source selection (unified vs agentDaily vs sessions) */
/* ================================================================== */

describe("computeUsage: data-source selection rules (hand-built dataset)", () => {
  // Unified daily deliberately DISAGREES with the per-agent sums so the tests
  // can prove which source was used:
  //   unified: 06-01 = 15.5, 06-02 = 20.2 (total 35.7)
  //   agentDaily: claude 06-01=10, 06-02=20 (30); codex 06-01=5 (5) → 35
  //   sessions: warpspeed session, cost 7.5, lastActivity 2026-06-15T18:00Z
  //             (= 2026-06-15 12:00 in America/Boise → dated 2026-06-15)
  const JUNE: DateRange = { from: "2026-06-01", to: "2026-06-30" };
  function sourceDataset(): MergedDataset {
    return mkDataset(
      [
        mkHost(
          "alpha",
          "Alpha",
          {
            daily: [
              hostDailyRow("2026-06-01", 15.5, { agents: ["claude", "codex"], totalTokens: 155 }),
              hostDailyRow("2026-06-02", 20.2, { agents: ["claude"], totalTokens: 202 }),
            ],
            agentDaily: {
              claude: [
                agentDailyRow("claude", "claude", "2026-06-01", 10, {
                  totalTokens: 100,
                  modelBreakdowns: [
                    { modelName: "claude-opus-4-8", cost: 10, inputTokens: 50, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
                  ],
                }),
                agentDailyRow("claude", "claude", "2026-06-02", 20, { totalTokens: 200 }),
              ],
              codex: [
                agentDailyRow("codex", "codex", "2026-06-01", 5, {
                  totalTokens: 50,
                  reasoningOutputTokens: 1234,
                }),
              ],
            },
            sessions: [
              sessionRow("warp-session-1", "warpspeed", 7.5, "2026-06-15T18:00:00.000Z", {
                totalTokens: 75,
              }),
            ],
            agents: ["claude", "codex", "warpspeed"],
          },
          JUNE,
        ),
      ],
      JUNE,
    );
  }

  test("all agents selected → KPI totals from unified daily (35.7, not 35)", () => {
    const r = computeUsage(sourceDataset(), allFilter("2026-06-01", "2026-06-30"), OPTS);
    expect(r.totals.cost).toBeCloseTo(35.7, 9);
  });

  test("harness stacked series is built from per-agent dailies, exact:true", () => {
    const r = computeUsage(sourceDataset(), allFilter("2026-06-01", "2026-06-30"), OPTS);
    const s = r.charts.dailyCostByHarness;
    expect(s.dimension).toBe("harness");
    expect(s.exact).toBe(true);
    expect(s.points.length).toBe(30);
    for (const k of s.keys) expect(k.kind).toBe("agent");
    const p1 = s.points[0]!; // 2026-06-01
    expect(p1.values["claude"]).toBeCloseTo(10, 9);
    expect(p1.values["codex"]).toBeCloseTo(5, 9);
    const p2 = s.points[1]!; // 2026-06-02
    expect(p2.values["claude"]).toBeCloseTo(20, 9);
    expect(p2.values["codex"] ?? 0).toBe(0);
  });

  test("agent subset [claude] → totals from claude agentDaily rows (exact 30)", () => {
    const r = computeUsage(
      sourceDataset(),
      { from: "2026-06-01", to: "2026-06-30", hosts: null, agents: ["claude"] },
      OPTS,
    );
    expect(r.totals.cost).toBeCloseTo(30, 9);
    expect(r.totals.totalTokens).toBe(300);
    expect(r.filter.allAgents).toBe(false);
  });

  test("agent subset [claude,codex] → 35 from agentDaily, NOT 35.7 from unified", () => {
    const r = computeUsage(
      sourceDataset(),
      { from: "2026-06-01", to: "2026-06-30", hosts: null, agents: ["claude", "codex"] },
      OPTS,
    );
    expect(r.totals.cost).toBeCloseTo(35, 9);
  });

  test("selected agent with no agentDaily anywhere → session fallback + warning", () => {
    const r = computeUsage(
      sourceDataset(),
      { from: "2026-06-01", to: "2026-06-30", hosts: null, agents: ["warpspeed"] },
      OPTS,
    );
    expect(r.totals.cost).toBeCloseTo(7.5, 9);
    expect(r.kpis.topHarness).toEqual(expect.objectContaining({ agent: "warpspeed" }));
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test("unknown/non-allowlisted agent still surfaces in availableAgents", () => {
    const r = computeUsage(sourceDataset(), allFilter("2026-06-01", "2026-06-30"), OPTS);
    expect(r.availableAgents).toEqual(["claude", "codex", "warpspeed"]);
  });
});

/* ================================================================== */
/* computeUsage — unified codex slices carry real model costs          */
/* ================================================================== */

describe("computeUsage: unified codex model data", () => {
  // `--by-agent` codex slices now carry authoritative per-model costs, so
  // they use the direct agentDaily path without an approximation warning.
  const JUNE: DateRange = { from: "2026-06-01", to: "2026-06-30" };
  const codexBd = (model: string, cost: number): ModelBreakdown => ({
    modelName: model,
    cost,
    inputTokens: 100,
    outputTokens: 10,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
  const realBd = (model: string, cost: number): ModelBreakdown => ({
    modelName: model,
    cost,
    inputTokens: 90,
    outputTokens: 9,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });

  function codexDataset(withSessions: boolean): MergedDataset {
    return mkDataset(
      [
        mkHost(
          "cx",
          "Codex box",
          {
            daily: [
              hostDailyRow("2026-06-01", 15, { agents: ["claude", "codex"], totalTokens: 150 }),
              hostDailyRow("2026-06-02", 7, { agents: ["codex"], totalTokens: 70 }),
            ],
            agentDaily: {
              claude: [
                agentDailyRow("claude", "claude", "2026-06-01", 10, {
                  totalTokens: 100,
                  modelBreakdowns: [realBd("claude-fable-5", 10)],
                }),
              ],
              codex: [
                agentDailyRow("codex", "codex", "2026-06-01", 5, {
                  totalTokens: 50,
                  modelBreakdowns: [codexBd("gpt-5.5", 5)],
                }),
                agentDailyRow("codex", "codex", "2026-06-02", 7, {
                  totalTokens: 70,
                  modelBreakdowns: [codexBd("glm-5.2:cloud", 7)],
                }),
              ],
            },
            // 2026-06-0xT18:00Z = 12:00 America/Boise → dated in range.
            sessions: withSessions
              ? [
                  sessionRow("cs-1", "codex", 4.5, "2026-06-01T18:00:00.000Z", {
                    totalTokens: 45,
                    modelBreakdowns: [realBd("gpt-5.5", 4.5)],
                  }),
                  sessionRow("cs-2", "codex", 6.75, "2026-06-02T18:00:00.000Z", {
                    totalTokens: 68,
                    modelBreakdowns: [realBd("glm-5.2:cloud", 6.75)],
                  }),
                ]
              : [],
            // "pi" observed too, so [claude,codex] stays a strict SUBSET
            // (with all agents selected the stack uses unified breakdowns).
            agents: ["claude", "codex", "pi"],
          },
          JUNE,
        ),
      ],
      JUNE,
    );
  }

  test("codex-only subset uses slice costs, not session-attributed costs", () => {
    const r = computeUsage(
      codexDataset(true),
      { from: "2026-06-01", to: "2026-06-30", hosts: null, agents: ["codex"] },
      OPTS,
    );
    // KPI totals stay authoritative from agentDaily rows: 5 + 7 = 12.
    expect(r.totals.cost).toBeCloseTo(12, 9);
    // Model chart uses the exact costs on the two unified daily slices.
    const s = r.charts.dailyCostByModel;
    expect(s.exact).toBe(false);
    expect(s.keys.map((k) => k.id).sort()).toEqual(["glm-5.2:cloud", "gpt-5.5"]);
    const chartTotal = s.points.reduce((a, p) => a + p.total, 0);
    expect(chartTotal).toBeCloseTo(12, 9);
    expect(r.kpis.topModel).toEqual({ model: "glm-5.2:cloud", cost: 7 });
    // byModel table rows are non-zero.
    const byModel = new Map(r.tables.byModel.map((row) => [row.key, row.cost]));
    expect(byModel.get("gpt-5.5")).toBeCloseTo(5, 9);
    expect(byModel.get("glm-5.2:cloud")).toBeCloseTo(7, 9);
    expect(
      r.warnings.some((w) => w.includes('"codex"') && w.includes("session-attributed model costs")),
    ).toBe(false);
  });

  test("mixed subset [claude,codex] sums direct daily model costs", () => {
    const r = computeUsage(
      codexDataset(true),
      { from: "2026-06-01", to: "2026-06-30", hosts: null, agents: ["claude", "codex"] },
      OPTS,
    );
    const s = r.charts.dailyCostByModel;
    const chartTotal = s.points.reduce((a, p) => a + p.total, 0);
    expect(chartTotal).toBeCloseTo(10 + 5 + 7, 9);
    expect(r.kpis.topModel).toEqual({ model: "claude-fable-5", cost: 10 });
  });

  test("codex model costs stay complete with no datable sessions", () => {
    const r = computeUsage(
      codexDataset(false),
      { from: "2026-06-01", to: "2026-06-30", hosts: null, agents: ["codex"] },
      OPTS,
    );
    const s = r.charts.dailyCostByModel;
    expect(s.keys.some((k) => k.id === noModelDataKey("codex"))).toBe(false);
    expect(s.points.reduce((sum, point) => sum + point.total, 0)).toBeCloseTo(12, 9);
    expect(r.warnings.some((w) => w.includes("session-attributed model costs"))).toBe(false);
  });

  test("real hermes slices likewise use their model breakdowns", () => {
    const ds = realDataset();
    const r = computeUsage(
      ds,
      { from: "2026-06-01", to: "2026-07-01", hosts: null, agents: ["hermes"] },
      OPTS,
    );
    expect(
      r.charts.dailyCostByModel.keys.some(
        (k) => k.id === noModelDataKey("hermes"),
      ),
    ).toBe(false);
    expect(r.charts.dailyCostByModel.keys.map((k) => k.id)).toContain("gpt-5.5");
  });
});

/* ================================================================== */
/* computeUsage — section failures surface as warnings                 */
/* ================================================================== */

describe("computeUsage: host sectionFailures surface in warnings", () => {
  test("a section-failed message reaches UsageResponse.warnings with the host id", () => {
    const ds = mkDataset(
      [
        mkHost("h1", "H1", { agents: ["hermes"] }, REAL_WINDOW, {
          sectionFailures: [
            "agentDaily:hermes section failed: JSON Parse error: Unexpected identifier",
          ],
        }),
      ],
      REAL_WINDOW,
    );
    const r = computeUsage(ds, allFilter("2026-06-01", "2026-06-30"), OPTS);
    expect(
      r.warnings.some(
        (w) => w.includes('Host "h1"') && w.includes("agentDaily:hermes section failed"),
      ),
    ).toBe(true);
  });
});

/* ================================================================== */
/* computeUsage — model stacking: top 8 + "other" (FR3)                */
/* ================================================================== */

describe("computeUsage: model stack top-8 + other (hand-built dataset)", () => {
  // 10 models on a single day, costs 100,90,...,10 (sum 550). Top 8 by cost =
  // first 8 names; "other" bucket = 20 + 10 = 30. Names are intentionally
  // messy real-world strings — they must be treated as opaque labels.
  const MODEL_COSTS: Array<[string, number]> = [
    ["[pi] claude-opus-4-8", 100],
    ["hf:zai-org/GLM-5.2", 90],
    ["glm-5.2:cloud", 80],
    ["gpt-5.3-codex-spark", 70],
    ["model-e", 60],
    ["model-f", 50],
    ["model-g", 40],
    ["model-h", 30],
    ["model-i", 20],
    ["model-j", 10],
  ];
  const DAY: DateRange = { from: "2026-06-01", to: "2026-06-01" };
  function modelDataset(): MergedDataset {
    const breakdowns: ModelBreakdown[] = MODEL_COSTS.map(([modelName, cost]) => ({
      modelName,
      cost,
      inputTokens: cost * 10,
      outputTokens: cost,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    }));
    return mkDataset(
      [
        mkHost(
          "m1",
          "Models",
          {
            daily: [
              hostDailyRow("2026-06-01", 550, {
                agents: ["claude"],
                modelsUsed: MODEL_COSTS.map(([n]) => n),
                modelBreakdowns: breakdowns,
                totalTokens: 6050,
              }),
            ],
            agents: ["claude"],
          },
          DAY,
        ),
      ],
      DAY,
    );
  }
  const run = () =>
    computeUsage(modelDataset(), allFilter("2026-06-01", "2026-06-01"), OPTS);

  test("keys are the top 8 models plus the other bucket, other last", () => {
    const s = run().charts.dailyCostByModel;
    expect(s.exact).toBe(true);
    expect(s.keys.length).toBe(9);
    const last = s.keys[s.keys.length - 1]!;
    expect(last.id).toBe(OTHER_MODELS_KEY);
    expect(last.label).toBe(OTHER_MODELS_LABEL);
    expect(last.kind).toBe("other");
    const ids = new Set(s.keys.map((k) => k.id));
    for (const [name] of MODEL_COSTS.slice(0, 8)) expect(ids.has(name)).toBe(true);
    expect(ids.has("model-i")).toBe(false); // folded into other
    expect(ids.has("model-j")).toBe(false);
  });

  test("point values: messy model names kept verbatim; other = 20+10 = 30", () => {
    const s = run().charts.dailyCostByModel;
    expect(s.points.length).toBe(1);
    const p = s.points[0]!;
    expect(p.values["[pi] claude-opus-4-8"]).toBeCloseTo(100, 9);
    expect(p.values["hf:zai-org/GLM-5.2"]).toBeCloseTo(90, 9);
    expect(p.values[OTHER_MODELS_KEY]).toBeCloseTo(30, 9);
    expect(p.total).toBeCloseTo(550, 9);
  });

  test("byModel table sorted cost desc with fractional shares summing to 1", () => {
    const rows = run().tables.byModel;
    expect(rows[0]!.key).toBe("[pi] claude-opus-4-8");
    expect(rows[0]!.cost).toBeCloseTo(100, 9);
    expect(rows[0]!.share).toBeCloseTo(100 / 550, 9);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.cost).toBeLessThanOrEqual(rows[i - 1]!.cost + 1e-9);
    }
    const shareSum = rows.reduce((a, r) => a + r.share, 0);
    expect(shareSum).toBeCloseTo(1, 6);
    for (const r of rows) expect(r.sparkline.length).toBe(1);
  });

  test("topModel KPI is the most expensive model", () => {
    const top = run().kpis.topModel;
    expect(top).not.toBeNull();
    expect(top!.model).toBe("[pi] claude-opus-4-8");
    expect(top!.cost).toBeCloseTo(100, 9);
  });
});

/* ================================================================== */
/* computeUsage — sessions table (FR4)                                 */
/* ================================================================== */

describe("computeUsage: sessions table", () => {
  const JUNE: DateRange = { from: "2026-06-01", to: "2026-06-30" };
  // 2026-06-15T12:00Z = 2026-06-15 06:00 in America/Boise → dated in range.
  const IN_RANGE_ISO = "2026-06-15T12:00:00.000Z";

  function capDataset(): MergedDataset {
    const sessions: SessionRow[] = [];
    for (let i = 0; i < 105; i++) {
      sessions.push(
        sessionRow(`sess-${String(i).padStart(3, "0")}`, "claude", i + 1, IN_RANGE_ISO, {
          projectPath: `/proj/p${i}`,
          totalTokens: (i + 1) * 10,
        }),
      );
    }
    return mkDataset(
      [mkHost("s1", "Sess", { sessions, agents: ["claude"] }, JUNE)],
      JUNE,
    );
  }

  test("top-100 by cost desc: 105 candidates → 100 rows, costs 105 down to 6", () => {
    const r = computeUsage(capDataset(), allFilter("2026-06-01", "2026-06-30"), OPTS);
    const rows = r.tables.sessions;
    expect(rows.length).toBe(100);
    expect(rows[0]!.cost).toBe(105);
    expect(rows[0]!.sessionId).toBe("sess-104");
    expect(rows[99]!.cost).toBe(6);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.cost).toBeLessThanOrEqual(rows[i - 1]!.cost);
    }
    expect(rows[0]!.hostId).toBe("s1");
    expect(rows[0]!.agent).toBe("claude");
  });

  test("opts.topSessions overrides the cap", () => {
    const r = computeUsage(capDataset(), allFilter("2026-06-01", "2026-06-30"), {
      ...OPTS,
      topSessions: 10,
    });
    expect(r.tables.sessions.length).toBe(10);
    expect(r.tables.sessions[9]!.cost).toBe(96);
  });

  test("agent filter restricts session rows", () => {
    const ds = mkDataset(
      [
        mkHost(
          "s2",
          "Sess2",
          {
            sessions: [
              sessionRow("c-1", "claude", 4, IN_RANGE_ISO),
              sessionRow("c-2", "claude", 2, IN_RANGE_ISO),
              sessionRow("x-1", "codex", 9, IN_RANGE_ISO),
            ],
            agents: ["claude", "codex"],
          },
          JUNE,
        ),
      ],
      JUNE,
    );
    const r = computeUsage(
      ds,
      { from: "2026-06-01", to: "2026-06-30", hosts: null, agents: ["claude"] },
      OPTS,
    );
    expect(r.tables.sessions.map((s) => s.sessionId)).toEqual(["c-1", "c-2"]);
    for (const s of r.tables.sessions) expect(s.agent).toBe("claude");
  });

  test("undated sessions are INCLUDED with a warning, never silently dropped", () => {
    const ds = mkDataset(
      [
        mkHost(
          "s3",
          "Sess3",
          {
            sessions: [
              sessionRow("dated-1", "claude", 5, IN_RANGE_ISO),
              // no lastActivity and no date embedded in the id → undateable
              sessionRow("opaque-xyz", "claude", 3, null),
            ],
            agents: ["claude"],
          },
          JUNE,
        ),
      ],
      JUNE,
    );
    const r = computeUsage(ds, allFilter("2026-06-01", "2026-06-30"), OPTS);
    const ids = r.tables.sessions.map((s) => s.sessionId).sort();
    expect(ids).toEqual(["dated-1", "opaque-xyz"]);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  test("sessions dated outside the range are excluded", () => {
    const ds = mkDataset(
      [
        mkHost(
          "s4",
          "Sess4",
          {
            sessions: [
              sessionRow("in-range", "claude", 5, IN_RANGE_ISO),
              sessionRow("too-old", "claude", 50, "2026-05-01T12:00:00.000Z"),
            ],
            agents: ["claude"],
          },
          { from: "2026-04-01", to: "2026-06-30" },
        ),
      ],
      { from: "2026-04-01", to: "2026-06-30" },
    );
    const r = computeUsage(ds, allFilter("2026-06-01", "2026-06-30"), OPTS);
    expect(r.tables.sessions.map((s) => s.sessionId)).toEqual(["in-range"]);
  });
});

/* ================================================================== */
/* computeUsage — full-precision aggregation (huge-cache-read fixture) */
/* ================================================================== */

describe("computeUsage: full precision with fixtures/synthetic/huge-cache-read.json", () => {
  const RANGE: DateRange = { from: "2026-06-01", to: "2026-06-02" };
  function hugeDataset(): MergedDataset {
    return mkDataset(
      [
        mkHost(
          "huge",
          "Huge",
          {
            daily: hugeCacheReadRaw.daily.map(mapUnifiedRow),
            agents: ["codex", "opencode"],
          },
          RANGE,
        ),
      ],
      RANGE,
    );
  }
  const run = () =>
    computeUsage(hugeDataset(), allFilter("2026-06-01", "2026-06-02"), OPTS);

  test("cost keeps its long float tail: 82.06393750000001 + 39.6598589700001", () => {
    // = 121.72379647000011 (matches the fixture's own totals.totalCost)
    expect(run().totals.cost).toBeCloseTo(82.06393750000001 + 39.6598589700001, 10);
    expect(run().totals.cost).toBeCloseTo(121.72379647000011, 10);
  });

  test("13-14 digit token counts survive exactly", () => {
    const t = run().totals;
    // 82060393750 + 47443987654321 = 47526048048071
    expect(t.cacheReadTokens).toBe(47526048048071);
    // 82066994312 + 47444023389871 = 47526090384183 (authoritative totalTokens)
    expect(t.totalTokens).toBe(47526090384183);
    expect(Number.isSafeInteger(t.cacheReadTokens)).toBe(true);
  });

  test("token composition carries the per-day huge cache reads verbatim", () => {
    const pts = run().charts.tokenComposition.points;
    expect(pts.length).toBe(2);
    expect(pts[0]!.date).toBe("2026-06-01");
    expect(pts[0]!.cacheReadTokens).toBe(82060393750);
    expect(pts[1]!.cacheReadTokens).toBe(47443987654321);
  });

  test("byModel table keeps the full-precision per-model cost", () => {
    const rows = computeUsage(
      hugeDataset(),
      allFilter("2026-06-01", "2026-06-02"),
      OPTS,
    ).tables.byModel;
    const kimi = rows.find(
      (r) => r.key === "accounts/fireworks/routers/kimi-k2p5-turbo",
    );
    expect(kimi).toBeDefined();
    expect(kimi!.cost).toBeCloseTo(39.6598589700001, 10);
    expect(kimi!.cacheReadTokens).toBe(47443987654321);
  });
});

/* ================================================================== */
/* computeUsage — empty data and filters that exclude everything       */
/* ================================================================== */

describe("computeUsage: empty dataset / empty intersection never crash (FR7)", () => {
  test("completely empty dataset → valid all-zero response with no NaN anywhere", () => {
    const ds: MergedDataset = { hosts: [], agents: [], coverage: null };
    const r = computeUsage(ds, allFilter("2026-06-01", "2026-06-30"), OPTS);
    expect(r.dateAxis.length).toBe(30);
    expect(r.totals).toEqual(emptyUsageTotals());
    expect(r.kpis.totalCost.value).toBe(0);
    expect(r.kpis.totalTokens.value).toBe(0);
    expect(r.kpis.activeDays.value).toBe(0);
    expect(Number.isFinite(r.kpis.dailyAverageCost.value)).toBe(true);
    expect(r.kpis.dailyAverageCost.value).toBe(0);
    expect(r.kpis.mostExpensiveDay).toBeNull();
    expect(r.kpis.topModel).toBeNull();
    expect(r.kpis.topHarness).toBeNull();
    expect(r.kpis.projectedMonthEnd).toBeNull(); // MTD has no data
    expect(r.charts.dailyCostByHost.points.length).toBe(30);
    for (const p of r.charts.dailyCostByHost.points) expect(p.total).toBe(0);
    for (const p of r.charts.cumulativeCost.points) expect(p.combined).toBe(0);
    for (const p of r.charts.tokenComposition.points) {
      expect(p.inputTokens).toBe(0);
      expect(p.cacheReadTokens).toBe(0);
    }
    expect(r.tables.byHost).toEqual([]);
    expect(r.tables.byHarness).toEqual([]);
    expect(r.tables.byModel).toEqual([]);
    expect(r.tables.sessions).toEqual([]);
    expect(r.availableHosts).toEqual([]);
    expect(r.availableAgents).toEqual([]);
  });

  test("null coverage → comparisons null with reason prior-period-not-covered", () => {
    const ds: MergedDataset = { hosts: [], agents: [], coverage: null };
    const r = computeUsage(ds, allFilter("2026-06-01", "2026-06-30"), OPTS);
    for (const kpi of [
      r.kpis.totalCost,
      r.kpis.totalTokens,
      r.kpis.dailyAverageCost,
      r.kpis.activeDays,
    ]) {
      expect(kpi.comparison).toBeNull();
      expect(kpi.comparisonUnavailableReason).toBe("prior-period-not-covered");
    }
  });

  test("host present but with empty data (empty-data.json) → zero response, host still listed", () => {
    const ds = mkDataset(
      [
        mkHost("e1", "Empty host", {
          daily: emptyDataRaw.daily.map(mapUnifiedRow), // []
          agents: [],
        }),
      ],
      REAL_WINDOW,
    );
    const r = computeUsage(ds, allFilter("2026-06-01", "2026-06-30"), OPTS);
    expect(r.totals.cost).toBe(0);
    expect(r.kpis.projectedMonthEnd).toBeNull();
    expect(r.availableHosts.map((h) => h.id)).toEqual(["e1"]);
    expect(r.charts.dailyCostByModel.points.length).toBe(30);
  });

  test("agent filter that matches nothing observed → all-zero response", () => {
    const r = computeUsage(
      realDataset(),
      { from: "2026-06-25", to: "2026-07-01", hosts: null, agents: ["nonexistent"] },
      OPTS,
    );
    expect(r.filter.agents).toEqual([]);
    expect(r.filter.allAgents).toBe(false);
    expect(r.totals.cost).toBe(0);
    expect(r.tables.byHarness).toEqual([]);
    expect(r.tables.sessions).toEqual([]);
  });
});

/* ================================================================== */
/* computeUsage — comparison coverage rule (FR2)                       */
/* ================================================================== */

describe("computeUsage: previous-period comparison coverage rule", () => {
  // Coverage 2026-06-04..2026-07-01. Usage: 10 on 06-24, 15 on 06-27.
  const COV: DateRange = { from: "2026-06-04", to: "2026-07-01" };
  function covDataset(): MergedDataset {
    return mkDataset(
      [
        mkHost(
          "c1",
          "Cov",
          {
            daily: [
              hostDailyRow("2026-06-24", 10, { totalTokens: 100 }),
              hostDailyRow("2026-06-27", 15, { totalTokens: 150 }),
            ],
            agents: ["claude"],
          },
          COV,
        ),
      ],
      COV,
    );
  }

  test("prior period fully covered → comparison computed (prev 06-18..06-24 = 10)", () => {
    const r = computeUsage(covDataset(), allFilter("2026-06-25", "2026-07-01"), OPTS);
    const k = r.kpis.totalCost;
    expect(k.value).toBeCloseTo(15, 9);
    expect(k.comparisonUnavailableReason).toBeNull();
    expect(k.comparison).not.toBeNull();
    expect(k.comparison!.previousValue).toBeCloseTo(10, 9);
    expect(k.comparison!.deltaAbsolute).toBeCloseTo(5, 9);
    expect(k.comparison!.deltaPercent).toBeCloseTo(0.5, 9);
    // activeDays compares too: 1 active day in each period
    expect(r.kpis.activeDays.comparison).not.toBeNull();
    expect(r.kpis.activeDays.comparison!.previousValue).toBe(1);
    expect(r.kpis.activeDays.comparison!.deltaAbsolute).toBe(0);
  });

  test("prior period sticking out of coverage → null comparison + reason on every KPI", () => {
    // filter 06-08..06-14 → prev 06-01..06-07, but coverage starts 06-04
    const r = computeUsage(covDataset(), allFilter("2026-06-08", "2026-06-14"), OPTS);
    for (const kpi of [
      r.kpis.totalCost,
      r.kpis.totalTokens,
      r.kpis.dailyAverageCost,
      r.kpis.activeDays,
    ]) {
      expect(kpi.comparison).toBeNull();
      expect(kpi.comparisonUnavailableReason).toBe("prior-period-not-covered");
    }
  });

  test("covered prior period with zero usage → comparison present, deltaPercent null", () => {
    // filter 06-11..06-17 → prev 06-04..06-10: covered but $0
    const r = computeUsage(covDataset(), allFilter("2026-06-11", "2026-06-17"), OPTS);
    const k = r.kpis.totalCost;
    expect(k.comparison).not.toBeNull();
    expect(k.comparisonUnavailableReason).toBeNull();
    expect(k.comparison!.previousValue).toBe(0);
    expect(k.comparison!.deltaPercent).toBeNull();
  });
});
