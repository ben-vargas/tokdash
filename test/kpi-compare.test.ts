/**
 * Area tests: FR2 KPIs, previous-period comparison, month-end projection.
 *
 * Covers src/shared/aggregate.ts helpers (previousPeriodComparison,
 * isRangeCovered, projectMonthEnd, computeUsage KPI composition) and the
 * dates.ts primitives the comparison/projection math is built on
 * (previousPeriod, daysInMonth, dayOfMonth, monthOf, monthToDateRange).
 *
 * Every expected value below was derived INDEPENDENTLY of the code under
 * test — by hand arithmetic or by jq over the fixture JSON (derivations in
 * comments). Report timezone: America/Boise; injected today = 2026-07-02
 * (day-of-month 2; July has 31 days).
 */

import { describe, expect, test } from "bun:test";

import {
  computeUsage,
  isRangeCovered,
  previousPeriodComparison,
  projectMonthEnd,
} from "../src/shared/aggregate";
import {
  dayOfMonth,
  daysInMonth,
  monthOf,
  monthToDateRange,
  previousPeriod,
} from "../src/shared/dates";
import type {
  AgentDailyDialect,
  AgentDailyRow,
  ComputeUsageOptions,
  DateRange,
  HostDailyRow,
  MergedDataset,
  MergedHostData,
  ModelBreakdown,
  TokenCounts,
  UsageFilter,
} from "../src/shared/types";

/* ------------------------------------------------------------------ */
/* Hand-built dataset helpers (no imports from normalize/merge stubs)  */
/* ------------------------------------------------------------------ */

function tk(
  input: number,
  output: number,
  cacheCreation: number,
  cacheRead: number,
  total: number,
): TokenCounts {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheCreationTokens: cacheCreation,
    cacheReadTokens: cacheRead,
    totalTokens: total,
  };
}

function mb(modelName: string, cost: number): ModelBreakdown {
  return {
    modelName,
    cost,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

function dailyRow(
  date: string,
  cost: number,
  tokens: TokenCounts,
  agents: string[],
  breakdowns: ModelBreakdown[],
): HostDailyRow {
  return {
    date,
    cost,
    ...tokens,
    agents,
    modelsUsed: breakdowns.map((b) => b.modelName),
    modelBreakdowns: breakdowns,
  };
}

function agentRow(
  agent: string,
  date: string,
  cost: number,
  tokens: TokenCounts,
  breakdowns: ModelBreakdown[] | null,
  _sourceShape: string,
): AgentDailyRow {
  return {
    agent,
    date,
    cost,
    ...tokens,
    modelsUsed: breakdowns ? breakdowns.map((b) => b.modelName) : [],
    modelBreakdowns: breakdowns,
    messageCount: null,
    reasoningOutputTokens: null,
    dialect: "unified",
  };
}

function makeHost(
  hostId: string,
  window: DateRange,
  daily: HostDailyRow[],
  agentDaily: Record<string, AgentDailyRow[]>,
  agents: string[],
): MergedHostData {
  return {
    hostId,
    label: hostId.toUpperCase(),
    color: "#7c8cf8",
    enabled: true,
    data: { daily, monthly: [], sessions: [], agentDaily, agents },
    fetchedAt: "2026-07-02T12:00:00.000Z",
    error: null,
    window,
  };
}

/**
 * Two-host dataset, hand-computed ledger (unified daily, authoritative):
 *
 *   host  date        cost    totalTokens (in/out/cc/cr)
 *   alpha 2026-06-21  15.00    4000 (1000/500/0/2000)      <- prev-period row
 *   alpha 2026-06-28  10.25    5000 (100/200/300/400)      <- totalTokens >> class sum (quirk a)
 *   alpha 2026-06-30   5.50   13500 (2000/1000/500/10000)
 *   alpha 2026-07-01   4.00    1000 (300/100/0/600)
 *   alpha 2026-07-02   2.00     200 (50/25/0/125)
 *   bravo 2026-06-30   7.25   10000 (700/300/0/9000)       <- duplicate date vs alpha: ADDS
 *   bravo 2026-07-02   1.00     100 (10/5/0/85)
 *
 * Filter window 2026-06-27..2026-07-03 (7 calendar days):
 *   totalCost   = 10.25+5.50+4.00+2.00+7.25+1.00           = 30.00
 *   totalTokens = 5000+13500+1000+200+10000+100            = 29800
 *   class sum   = 3160+1630+800+20210                      = 25800  (< 29800 on purpose)
 *   activeDays  = {06-28, 06-30, 07-01, 07-02}             = 4
 *   mostExpensiveDay = 2026-06-30: 5.50+7.25               = 12.75
 *   model costs: model-a 10.25+2+2+7.25 = 21.50; model-b 3.5+4 = 7.50; model-c 1.00
 *   harness costs (agentDaily, consistent with unified):
 *     claude 10.25+2.00+2.00+7.25+1.00 = 22.50; codex 3.50+4.00 = 7.50
 * Previous period 2026-06-20..2026-06-26: cost 15.00, tokens 4000, activeDays 1.
 * July MTD (today 2026-07-02): 4.00+2.00+1.00 = 7.00 -> projected 7/2*31 = 108.5.
 * Coverage (set directly): 2026-04-06..2026-07-02.
 */
function makeTwoHostDataset(): MergedDataset {
  const alpha = makeHost(
    "alpha",
    { from: "2026-04-04", to: "2026-07-02" },
    [
      dailyRow("2026-06-21", 15.0, tk(1000, 500, 0, 2000, 4000), ["claude"], [
        mb("model-a", 15.0),
      ]),
      dailyRow("2026-06-28", 10.25, tk(100, 200, 300, 400, 5000), ["claude"], [
        mb("model-a", 10.25),
      ]),
      dailyRow(
        "2026-06-30",
        5.5,
        tk(2000, 1000, 500, 10000, 13500),
        ["claude", "codex"],
        [mb("model-a", 2.0), mb("model-b", 3.5)],
      ),
      dailyRow("2026-07-01", 4.0, tk(300, 100, 0, 600, 1000), ["codex"], [
        mb("model-b", 4.0),
      ]),
      dailyRow("2026-07-02", 2.0, tk(50, 25, 0, 125, 200), ["claude"], [
        mb("model-a", 2.0),
      ]),
    ],
    {
      claude: [
        agentRow("claude", "2026-06-21", 15.0, tk(1000, 500, 0, 2000, 4000), [mb("model-a", 15.0)], "claude"),
        agentRow("claude", "2026-06-28", 10.25, tk(100, 200, 300, 400, 5000), [mb("model-a", 10.25)], "claude"),
        agentRow("claude", "2026-06-30", 2.0, tk(500, 200, 300, 1000, 2000), [mb("model-a", 2.0)], "claude"),
        agentRow("claude", "2026-07-02", 2.0, tk(50, 25, 0, 125, 200), [mb("model-a", 2.0)], "claude"),
      ],
      codex: [
        agentRow("codex", "2026-06-30", 3.5, tk(1500, 800, 200, 9000, 11500), [mb("model-b", 3.5)], "codex"),
        agentRow("codex", "2026-07-01", 4.0, tk(300, 100, 0, 600, 1000), [mb("model-b", 4.0)], "codex"),
      ],
    },
    ["claude", "codex"],
  );
  const bravo = makeHost(
    "bravo",
    { from: "2026-04-06", to: "2026-07-02" },
    [
      dailyRow("2026-06-30", 7.25, tk(700, 300, 0, 9000, 10000), ["claude"], [
        mb("model-a", 7.25),
      ]),
      dailyRow("2026-07-02", 1.0, tk(10, 5, 0, 85, 100), ["claude"], [
        mb("model-c", 1.0),
      ]),
    ],
    {
      claude: [
        agentRow("claude", "2026-06-30", 7.25, tk(700, 300, 0, 9000, 10000), [mb("model-a", 7.25)], "claude"),
        agentRow("claude", "2026-07-02", 1.0, tk(10, 5, 0, 85, 100), [mb("model-c", 1.0)], "claude"),
      ],
    },
    ["claude"],
  );
  return {
    hosts: [alpha, bravo],
    agents: ["claude", "codex"],
    coverage: { from: "2026-04-06", to: "2026-07-02" },
  };
}

const BOISE_OPTS: ComputeUsageOptions = {
  today: "2026-07-02",
  timezone: "America/Boise",
};

/** The default 7-day test window (all hosts, all agents). */
const WEEK_FILTER: UsageFilter = {
  from: "2026-06-27",
  to: "2026-07-03",
  hosts: null,
  agents: null,
};

/** Map a raw unified-daily fixture row (period/totalCost keys) to a HostDailyRow. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawUnifiedToHostDaily(row: any): HostDailyRow {
  return {
    date: row.period as string,
    cost: (row.totalCost as number) ?? 0,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
    cacheCreationTokens: row.cacheCreationTokens ?? 0,
    cacheReadTokens: row.cacheReadTokens ?? 0,
    totalTokens: row.totalTokens ?? 0,
    agents: row.metadata?.agents ?? [],
    modelsUsed: row.modelsUsed ?? [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    modelBreakdowns: (row.modelBreakdowns ?? []).map((b: any) => ({
      modelName: b.modelName as string,
      cost: b.cost ?? 0,
      inputTokens: b.inputTokens ?? 0,
      outputTokens: b.outputTokens ?? 0,
      cacheCreationTokens: b.cacheCreationTokens ?? 0,
      cacheReadTokens: b.cacheReadTokens ?? 0,
    })),
  };
}

async function loadUnifiedDailyFixture(name: string): Promise<HostDailyRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any = await Bun.file(
    `${import.meta.dir}/../fixtures/synthetic/${name}`,
  ).json();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (raw.daily as any[]).map(rawUnifiedToHostDaily);
}

/* ================================================================== */
/* dates.ts — previousPeriod (FR2 comparison basis)                    */
/* ================================================================== */

describe("previousPeriod", () => {
  test("30-day June range -> immediately preceding 30 days (2026-05-02..2026-05-31)", () => {
    // N = 30; from-30 = 2026-05-02, from-1 = 2026-05-31 (spec example).
    expect(previousPeriod({ from: "2026-06-01", to: "2026-06-30" })).toEqual({
      from: "2026-05-02",
      to: "2026-05-31",
    });
  });

  test("single-day range -> the single preceding day", () => {
    expect(previousPeriod({ from: "2026-06-15", to: "2026-06-15" })).toEqual({
      from: "2026-06-14",
      to: "2026-06-14",
    });
  });

  test("7d preset ending 2026-07-02 -> 2026-06-19..2026-06-25 (crosses month boundary)", () => {
    // 7d range = 2026-06-26..2026-07-02; N=7: from-7 = 06-19, from-1 = 06-25.
    expect(previousPeriod({ from: "2026-06-26", to: "2026-07-02" })).toEqual({
      from: "2026-06-19",
      to: "2026-06-25",
    });
  });

  test("crosses a year boundary", () => {
    expect(previousPeriod({ from: "2026-01-01", to: "2026-01-01" })).toEqual({
      from: "2025-12-31",
      to: "2025-12-31",
    });
  });

  test("crosses leap-year February (2028 is a leap year)", () => {
    // N = 2: from-2 = 2028-02-28, from-1 = 2028-02-29 (leap day exists).
    expect(previousPeriod({ from: "2028-03-01", to: "2028-03-02" })).toEqual({
      from: "2028-02-28",
      to: "2028-02-29",
    });
  });
});

/* ================================================================== */
/* dates.ts — month math backing the projection                        */
/* ================================================================== */

describe("month math (daysInMonth / dayOfMonth / monthOf / monthToDateRange)", () => {
  test("daysInMonth is leap-aware", () => {
    expect(daysInMonth("2026-07")).toBe(31);
    expect(daysInMonth("2026-06")).toBe(30);
    expect(daysInMonth("2026-02")).toBe(28); // 2026 is not a leap year
    expect(daysInMonth("2028-02")).toBe(29); // 2028 is
    expect(daysInMonth("2000-02")).toBe(29); // divisible by 400 -> leap
    expect(daysInMonth("1900-02")).toBe(28); // divisible by 100, not 400 -> not leap
    expect(daysInMonth("2026-12")).toBe(31);
  });

  test("dayOfMonth is 1-based", () => {
    expect(dayOfMonth("2026-07-02")).toBe(2);
    expect(dayOfMonth("2026-07-01")).toBe(1);
    expect(dayOfMonth("2026-07-31")).toBe(31);
  });

  test("monthOf extracts YYYY-MM", () => {
    expect(monthOf("2026-07-02")).toBe("2026-07");
    expect(monthOf("2026-12-31")).toBe("2026-12");
  });

  test("monthToDateRange spans the 1st through today inclusive", () => {
    expect(monthToDateRange("2026-07-02")).toEqual({
      from: "2026-07-01",
      to: "2026-07-02",
    });
    // Degenerate: today IS the 1st -> single-day MTD range.
    expect(monthToDateRange("2026-07-01")).toEqual({
      from: "2026-07-01",
      to: "2026-07-01",
    });
  });
});

/* ================================================================== */
/* previousPeriodComparison — delta math                               */
/* ================================================================== */

describe("previousPeriodComparison", () => {
  test("increase: 118 vs 100 -> +18 absolute, +0.18 FRACTION (not 18)", () => {
    const c = previousPeriodComparison(118, 100);
    expect(c.previousValue).toBe(100);
    expect(c.deltaAbsolute).toBeCloseTo(18, 10);
    expect(c.deltaPercent).toBeCloseTo(0.18, 12);
  });

  test("doubling gives deltaPercent 1.0 (fraction semantics)", () => {
    const c = previousPeriodComparison(2, 1);
    expect(c.deltaAbsolute).toBeCloseTo(1, 12);
    expect(c.deltaPercent).toBeCloseTo(1.0, 12);
  });

  test("decrease: 47.4 vs 50 -> -2.6 absolute, -0.052 fraction", () => {
    const c = previousPeriodComparison(47.4, 50);
    expect(c.previousValue).toBe(50);
    expect(c.deltaAbsolute).toBeCloseTo(-2.6, 10);
    expect(c.deltaPercent).toBeCloseTo(-0.052, 10);
  });

  test("previous 0 -> deltaPercent null (undefined ratio, NEVER Infinity/NaN)", () => {
    const c = previousPeriodComparison(30, 0);
    expect(c.previousValue).toBe(0);
    expect(c.deltaAbsolute).toBe(30);
    expect(c.deltaPercent).toBeNull();
  });

  test("both 0 -> zero absolute delta, null percent", () => {
    const c = previousPeriodComparison(0, 0);
    expect(c.previousValue).toBe(0);
    expect(c.deltaAbsolute).toBe(0);
    expect(c.deltaPercent).toBeNull();
  });
});

/* ================================================================== */
/* isRangeCovered — the FR2 coverage gate                              */
/* ================================================================== */

describe("isRangeCovered", () => {
  const coverage: DateRange = { from: "2026-04-03", to: "2026-07-02" };

  test("range equal to coverage is covered (inclusive bounds)", () => {
    expect(isRangeCovered({ from: "2026-04-03", to: "2026-07-02" }, coverage)).toBe(true);
  });

  test("range strictly inside coverage is covered", () => {
    expect(isRangeCovered({ from: "2026-06-01", to: "2026-06-30" }, coverage)).toBe(true);
  });

  test("range starting one day before coverage is NOT covered", () => {
    expect(isRangeCovered({ from: "2026-04-02", to: "2026-06-30" }, coverage)).toBe(false);
  });

  test("range ending after coverage is NOT covered", () => {
    expect(isRangeCovered({ from: "2026-06-01", to: "2026-07-03" }, coverage)).toBe(false);
  });

  test("null coverage (nothing fetched) -> never covered", () => {
    expect(isRangeCovered({ from: "2026-06-01", to: "2026-06-30" }, null)).toBe(false);
  });

  test("FR2 scenario: 90d preset with only a 90-day fetch window -> prior period not covered", () => {
    // 90d preset ending 2026-07-02 = 2026-04-04..2026-07-02.
    // Hand-derived previous period: doy(2026-04-04)=94; 94-90=4 -> 2026-01-04;
    // to = from-1 = 2026-04-03. Fetch window (90 days) = 2026-04-03..2026-07-02.
    const prev = previousPeriod({ from: "2026-04-04", to: "2026-07-02" });
    expect(prev).toEqual({ from: "2026-01-04", to: "2026-04-03" });
    expect(isRangeCovered(prev, coverage)).toBe(false);
  });
});

/* ================================================================== */
/* projectMonthEnd — naive linear projection                           */
/* ================================================================== */

describe("projectMonthEnd", () => {
  test("today=2026-07-02 (Boise), MTD $7 -> 7/2*31 = $108.50", () => {
    const p = projectMonthEnd(7.0, "2026-07-02");
    expect(p.month).toBe("2026-07");
    expect(p.daysElapsed).toBe(2);
    expect(p.daysInMonth).toBe(31);
    expect(p.monthToDateCost).toBeCloseTo(7.0, 12);
    expect(p.projectedCost).toBeCloseTo(108.5, 10);
  });

  test("first day of month: daysElapsed 1, no division by zero", () => {
    const p = projectMonthEnd(12.5, "2026-07-01");
    expect(p.daysElapsed).toBe(1);
    expect(p.daysInMonth).toBe(31);
    // 12.5 / 1 * 31 = 387.5
    expect(p.projectedCost).toBeCloseTo(387.5, 10);
    expect(Number.isFinite(p.projectedCost)).toBe(true);
  });

  test("last day of month: projection equals MTD (x/30*30)", () => {
    const p = projectMonthEnd(52.909979, "2026-06-30");
    expect(p.month).toBe("2026-06");
    expect(p.daysElapsed).toBe(30);
    expect(p.daysInMonth).toBe(30);
    expect(p.projectedCost).toBeCloseTo(52.909979, 10);
  });

  test("leap-day February (2028-02-29): daysInMonth 29", () => {
    const p = projectMonthEnd(29.0, "2028-02-29");
    expect(p.month).toBe("2028-02");
    expect(p.daysElapsed).toBe(29);
    expect(p.daysInMonth).toBe(29);
    expect(p.projectedCost).toBeCloseTo(29.0, 12);
  });

  test("non-leap February mid-month: 7/14*28 = 14", () => {
    const p = projectMonthEnd(7.0, "2026-02-14");
    expect(p.daysElapsed).toBe(14);
    expect(p.daysInMonth).toBe(28);
    expect(p.projectedCost).toBeCloseTo(14.0, 10);
  });

  test("zero MTD projects to zero (not NaN)", () => {
    const p = projectMonthEnd(0, "2026-07-02");
    expect(p.monthToDateCost).toBe(0);
    expect(p.projectedCost).toBe(0);
  });

  test("full float precision preserved: 0.1/3*31", () => {
    const p = projectMonthEnd(0.1, "2026-07-03");
    expect(p.daysElapsed).toBe(3);
    expect(p.projectedCost).toBeCloseTo(1.0333333333333332, 12);
  });
});

/* ================================================================== */
/* computeUsage — FR2 KPIs on the hand-built two-host dataset          */
/* ================================================================== */

describe("computeUsage KPIs (hand-built two-host dataset, all hosts/agents)", () => {
  test("totalCost sums unified daily across hosts in range: $30.00", () => {
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    expect(resp.kpis.totalCost.value).toBeCloseTo(30.0, 10);
    expect(resp.totals.cost).toBeCloseTo(30.0, 10);
  });

  test("totalTokens uses AUTHORITATIVE totalTokens (29800), never the 4-class sum (25800)", () => {
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    expect(resp.kpis.totalTokens.value).toBe(29800);
    const classSum =
      resp.totals.inputTokens +
      resp.totals.outputTokens +
      resp.totals.cacheCreationTokens +
      resp.totals.cacheReadTokens;
    expect(classSum).toBe(25800);
    expect(resp.kpis.totalTokens.value).toBeGreaterThan(classSum);
  });

  test("dailyAverageCost divides by CALENDAR days in range (7), not active days (4)", () => {
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    // 30 / 7 = 4.285714285714286 — NOT 30/4 = 7.5.
    expect(resp.kpis.dailyAverageCost.value).toBeCloseTo(4.285714285714286, 10);
  });

  test("activeDays counts only days with cost > 0: 4 of 7", () => {
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    expect(resp.kpis.activeDays.value).toBe(4);
  });

  test("mostExpensiveDay adds duplicate dates across hosts: 2026-06-30 = 5.50+7.25 = 12.75", () => {
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    expect(resp.kpis.mostExpensiveDay).not.toBeNull();
    expect(resp.kpis.mostExpensiveDay!.date).toBe("2026-06-30");
    expect(resp.kpis.mostExpensiveDay!.cost).toBeCloseTo(12.75, 10);
  });

  test("topModel by cost: model-a $21.50 (10.25+2+2+7.25)", () => {
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    expect(resp.kpis.topModel).not.toBeNull();
    expect(resp.kpis.topModel!.model).toBe("model-a");
    expect(resp.kpis.topModel!.cost).toBeCloseTo(21.5, 10);
  });

  test("topHarness by cost: claude $22.50 vs codex $7.50", () => {
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    expect(resp.kpis.topHarness).not.toBeNull();
    expect(resp.kpis.topHarness!.agent).toBe("claude");
    expect(resp.kpis.topHarness!.cost).toBeCloseTo(22.5, 10);
  });

  test("projectedMonthEnd: July MTD 7.00 / 2 days * 31 days = 108.50 (Boise, today 2026-07-02)", () => {
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    const p = resp.kpis.projectedMonthEnd;
    expect(p).not.toBeNull();
    expect(p!.month).toBe("2026-07");
    expect(p!.daysElapsed).toBe(2);
    expect(p!.daysInMonth).toBe(31);
    expect(p!.monthToDateCost).toBeCloseTo(7.0, 10);
    expect(p!.projectedCost).toBeCloseTo(108.5, 10);
  });

  test("projectedMonthEnd is NOT date-filtered: a June-only filter still projects July MTD", () => {
    const juneOnly: UsageFilter = {
      from: "2026-06-01",
      to: "2026-06-30",
      hosts: null,
      agents: null,
    };
    const resp = computeUsage(makeTwoHostDataset(), juneOnly, BOISE_OPTS);
    // Range totals exclude July: 15 + 10.25 + 5.5 + 7.25 = 38.00...
    expect(resp.kpis.totalCost.value).toBeCloseTo(38.0, 10);
    // ...but the projection still sees July's 4+2+1 = 7.00 MTD.
    expect(resp.kpis.projectedMonthEnd).not.toBeNull();
    expect(resp.kpis.projectedMonthEnd!.monthToDateCost).toBeCloseTo(7.0, 10);
    expect(resp.kpis.projectedMonthEnd!.projectedCost).toBeCloseTo(108.5, 10);
  });
});

/* ================================================================== */
/* computeUsage — previous-period comparisons (FR2)                    */
/* ================================================================== */

describe("computeUsage previous-period comparisons", () => {
  test("covered prior period with data: cost 30 vs 15 -> +100% as fraction 1.0", () => {
    // prev(2026-06-27..2026-07-03) = 2026-06-20..2026-06-26 (inside coverage
    // 2026-04-06..2026-07-02); prior cost = the single 06-21 row = 15.00.
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    const c = resp.kpis.totalCost.comparison;
    expect(c).not.toBeNull();
    expect(resp.kpis.totalCost.comparisonUnavailableReason).toBeNull();
    expect(c!.previousValue).toBeCloseTo(15.0, 10);
    expect(c!.deltaAbsolute).toBeCloseTo(15.0, 10);
    expect(c!.deltaPercent).toBeCloseTo(1.0, 10);
  });

  test("token comparison: 29800 vs 4000 -> deltaPercent 6.45", () => {
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    const c = resp.kpis.totalTokens.comparison;
    expect(c).not.toBeNull();
    expect(c!.previousValue).toBe(4000);
    expect(c!.deltaAbsolute).toBe(25800);
    expect(c!.deltaPercent).toBeCloseTo(6.45, 10);
  });

  test("activeDays comparison: 4 vs 1 -> +3, +300% (fraction 3.0)", () => {
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    const c = resp.kpis.activeDays.comparison;
    expect(c).not.toBeNull();
    expect(c!.previousValue).toBe(1);
    expect(c!.deltaAbsolute).toBe(3);
    expect(c!.deltaPercent).toBeCloseTo(3.0, 10);
  });

  test("dailyAverageCost comparison uses equal-length windows: (30/7) vs (15/7) -> fraction 1.0", () => {
    const resp = computeUsage(makeTwoHostDataset(), WEEK_FILTER, BOISE_OPTS);
    const c = resp.kpis.dailyAverageCost.comparison;
    expect(c).not.toBeNull();
    expect(c!.previousValue).toBeCloseTo(15 / 7, 10);
    expect(c!.deltaPercent).toBeCloseTo(1.0, 10);
  });

  test("covered prior period with ZERO usage: comparison present, deltaPercent null (not Infinity)", () => {
    // Filter 2026-06-27..2026-06-28 (2 days) -> prev = 2026-06-25..2026-06-26:
    // covered by 2026-04-06..2026-07-02 but has no rows -> previous total 0.
    const filter: UsageFilter = {
      from: "2026-06-27",
      to: "2026-06-28",
      hosts: null,
      agents: null,
    };
    const resp = computeUsage(makeTwoHostDataset(), filter, BOISE_OPTS);
    expect(resp.kpis.totalCost.value).toBeCloseTo(10.25, 10);
    const c = resp.kpis.totalCost.comparison;
    expect(c).not.toBeNull();
    expect(resp.kpis.totalCost.comparisonUnavailableReason).toBeNull();
    expect(c!.previousValue).toBe(0);
    expect(c!.deltaAbsolute).toBeCloseTo(10.25, 10);
    expect(c!.deltaPercent).toBeNull();
  });

  test("prior period NOT covered: comparison null + machine-readable reason on EVERY KpiValue, values still computed", () => {
    // Filter = the full coverage window 2026-04-06..2026-07-02; its previous
    // period ends 2026-04-05 < coverage.from -> not covered.
    const filter: UsageFilter = {
      from: "2026-04-06",
      to: "2026-07-02",
      hosts: null,
      agents: null,
    };
    const resp = computeUsage(makeTwoHostDataset(), filter, BOISE_OPTS);
    for (const kpi of [
      resp.kpis.totalCost,
      resp.kpis.totalTokens,
      resp.kpis.dailyAverageCost,
      resp.kpis.activeDays,
    ]) {
      expect(kpi.comparison).toBeNull();
      expect(kpi.comparisonUnavailableReason).toBe("prior-period-not-covered");
    }
    // Values are still computed: 15+10.25+5.5+4+2 + 7.25+1 = 45.00; 5 active days.
    expect(resp.kpis.totalCost.value).toBeCloseTo(45.0, 10);
    expect(resp.kpis.activeDays.value).toBe(5);
  });

  test("comparison is pure: input dataset is not mutated and results are deterministic", () => {
    const dataset = makeTwoHostDataset();
    const before = JSON.stringify(dataset);
    const a = computeUsage(dataset, WEEK_FILTER, BOISE_OPTS);
    expect(JSON.stringify(dataset)).toBe(before); // no mutation (never fetches/widens)
    const b = computeUsage(dataset, WEEK_FILTER, BOISE_OPTS);
    expect(b).toEqual(a); // same inputs -> identical output
  });
});

/* ================================================================== */
/* computeUsage — FR2 coverage gating over INCLUDED hosts only         */
/* ================================================================== */

describe("computeUsage: coverage gating ignores hosts that contribute no data", () => {
  // Regression: coverage used to be the window intersection over ALL hosts
  // with a snapshot — so a DISABLED host (whose window stops advancing) or a
  // host excluded via ?hosts= permanently forced every comparison to "—"
  // even though the included hosts fully covered the prior period.
  function staleHost(enabled: boolean): MergedHostData {
    const h = makeHost(
      "stale",
      { from: "2026-04-20", to: "2026-05-15" }, // window frozen in mid-May
      [],
      {},
      [],
    );
    h.enabled = enabled;
    return h;
  }

  test("a DISABLED host's frozen window does not suppress comparisons", () => {
    const ds = makeTwoHostDataset();
    ds.hosts.push(staleHost(false));
    // what mergeHosts computes over ALL snapshots (the old, wrong gate):
    ds.coverage = { from: "2026-04-20", to: "2026-05-15" };
    const r = computeUsage(ds, WEEK_FILTER, BOISE_OPTS);
    expect(r.kpis.totalCost.comparisonUnavailableReason).toBeNull();
    expect(r.kpis.totalCost.comparison).not.toBeNull();
    expect(r.kpis.totalCost.comparison!.previousValue).toBeCloseTo(15.0, 10);
  });

  test("an ENABLED host excluded via the hosts filter does not suppress comparisons", () => {
    const ds = makeTwoHostDataset();
    ds.hosts.push(staleHost(true));
    ds.coverage = { from: "2026-04-20", to: "2026-05-15" };
    const r = computeUsage(
      ds,
      { ...WEEK_FILTER, hosts: ["alpha", "bravo"] },
      BOISE_OPTS,
    );
    expect(r.kpis.totalCost.comparisonUnavailableReason).toBeNull();
    expect(r.kpis.totalCost.comparison).not.toBeNull();
  });

  test("an INCLUDED short-window host still suppresses (the rule itself is unchanged)", () => {
    const ds = makeTwoHostDataset();
    ds.hosts.push(staleHost(true)); // enabled AND included (hosts: null)
    const r = computeUsage(ds, WEEK_FILTER, BOISE_OPTS);
    // included-host intersection ends 2026-05-15 < prev period 06-20..06-26
    expect(r.kpis.totalCost.comparison).toBeNull();
    expect(r.kpis.totalCost.comparisonUnavailableReason).toBe(
      "prior-period-not-covered",
    );
  });
});

/* ================================================================== */
/* computeUsage — projectedMonthEnd coverage gating (FR2)              */
/* ================================================================== */

describe("computeUsage: projectedMonthEnd is coverage-gated on the month start", () => {
  test("a fetch window starting mid-month suppresses the projection instead of understating it", () => {
    // Regression: window 2026-07-16..2026-07-20 at $100/day, today
    // 2026-07-20 → the old code reported monthToDateCost 500 / projection
    // 775 with no warning; true MTD is unknowable from this window.
    const window: DateRange = { from: "2026-07-16", to: "2026-07-20" };
    const days = ["2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20"];
    const ds: MergedDataset = {
      hosts: [
        makeHost(
          "narrow",
          window,
          days.map((d) => dailyRow(d, 100, tk(10, 10, 0, 0, 20), ["claude"], [])),
          {},
          ["claude"],
        ),
      ],
      agents: ["claude"],
      coverage: window,
    };
    const opts: ComputeUsageOptions = { today: "2026-07-20", timezone: "America/Boise" };
    const r = computeUsage(
      ds,
      { from: "2026-07-16", to: "2026-07-20", hosts: null, agents: null },
      opts,
    );
    expect(r.kpis.projectedMonthEnd).toBeNull(); // NOT 500/20*31 = 775
    expect(r.warnings.some((w) => w.includes("Month-to-date"))).toBe(true);
  });

  test("coverage.to before today does NOT suppress (yesterday's snapshot still covers the month start)", () => {
    const window: DateRange = { from: "2026-06-01", to: "2026-07-01" };
    const ds: MergedDataset = {
      hosts: [
        makeHost(
          "h",
          window,
          [dailyRow("2026-07-01", 31, tk(1, 1, 0, 0, 2), ["claude"], [])],
          {},
          ["claude"],
        ),
      ],
      agents: ["claude"],
      coverage: window,
    };
    const r = computeUsage(
      ds,
      { from: "2026-06-27", to: "2026-07-02", hosts: null, agents: null },
      BOISE_OPTS, // today 2026-07-02 > coverage.to 2026-07-01
    );
    expect(r.kpis.projectedMonthEnd).not.toBeNull();
    expect(r.kpis.projectedMonthEnd!.monthToDateCost).toBeCloseTo(31, 10);
  });
});

/* ================================================================== */
/* computeUsage — KPIs under host / harness filters                    */
/* ================================================================== */

describe("computeUsage KPIs under filters", () => {
  test("host subset: hosts=[alpha] -> total 21.75, mostExpensiveDay 2026-06-28 ($10.25)", () => {
    const filter: UsageFilter = { ...WEEK_FILTER, hosts: ["alpha"] };
    const resp = computeUsage(makeTwoHostDataset(), filter, BOISE_OPTS);
    // alpha in range: 10.25 + 5.5 + 4 + 2 = 21.75; bravo's 06-30 excluded, so
    // 06-28 (10.25) beats 06-30 (5.50).
    expect(resp.kpis.totalCost.value).toBeCloseTo(21.75, 10);
    expect(resp.kpis.mostExpensiveDay!.date).toBe("2026-06-28");
    expect(resp.kpis.mostExpensiveDay!.cost).toBeCloseTo(10.25, 10);
  });

  test("agent subset: agents=[codex] -> exact totals from per-agent dailies (7.50, 12500 tokens)", () => {
    const filter: UsageFilter = { ...WEEK_FILTER, agents: ["codex"] };
    const resp = computeUsage(makeTwoHostDataset(), filter, BOISE_OPTS);
    // codex agentDaily in range: 3.50 (06-30) + 4.00 (07-01) = 7.50;
    // tokens 11500 + 1000 = 12500.
    expect(resp.kpis.totalCost.value).toBeCloseTo(7.5, 10);
    expect(resp.kpis.totalTokens.value).toBe(12500);
    expect(resp.kpis.activeDays.value).toBe(2);
    expect(resp.kpis.mostExpensiveDay!.date).toBe("2026-07-01");
    expect(resp.kpis.mostExpensiveDay!.cost).toBeCloseTo(4.0, 10);
    expect(resp.kpis.topHarness!.agent).toBe("codex");
    expect(resp.kpis.topHarness!.cost).toBeCloseTo(7.5, 10);
  });

  test("agent-subset comparison: codex prior week has zero usage -> deltaPercent null", () => {
    const filter: UsageFilter = { ...WEEK_FILTER, agents: ["codex"] };
    const resp = computeUsage(makeTwoHostDataset(), filter, BOISE_OPTS);
    const c = resp.kpis.totalCost.comparison;
    expect(c).not.toBeNull(); // prev window IS covered, just empty for codex
    expect(c!.previousValue).toBe(0);
    expect(c!.deltaPercent).toBeNull();
  });

  test("projection honors the agent filter: claude MTD 3.00 -> 46.50; codex has no MTD data -> null", () => {
    const claude = computeUsage(
      makeTwoHostDataset(),
      { ...WEEK_FILTER, agents: ["claude"] },
      BOISE_OPTS,
    );
    // claude July rows: alpha 07-02 2.00 + bravo 07-02 1.00 = 3.00 -> 3/2*31 = 46.5.
    expect(claude.kpis.projectedMonthEnd).not.toBeNull();
    expect(claude.kpis.projectedMonthEnd!.monthToDateCost).toBeCloseTo(3.0, 10);
    expect(claude.kpis.projectedMonthEnd!.projectedCost).toBeCloseTo(46.5, 10);

    const codex = computeUsage(
      makeTwoHostDataset(),
      { ...WEEK_FILTER, agents: ["codex"] },
      BOISE_OPTS,
    );
    // CORRECTION: the original comment ("codex has no rows in July") is
    // contradicted by this file's own dataset ledger — codex agentDaily HAS a
    // 2026-07-01 row costing 4.00 (see makeTwoHostDataset), and 07-01 is in
    // July. MTD includes today's month rows (the claude case above and the
    // combined "4+2+1 = 7.00" ledger both assume that), so the codex-filtered
    // July MTD is 4.00 -> projected 4.00 / 2 * 31 = 62.00.
    expect(codex.kpis.projectedMonthEnd).not.toBeNull();
    expect(codex.kpis.projectedMonthEnd!.monthToDateCost).toBeCloseTo(4.0, 10);
    expect(codex.kpis.projectedMonthEnd!.projectedCost).toBeCloseTo(62.0, 10);
  });
});

/* ================================================================== */
/* computeUsage — fixture-driven KPI cases                             */
/* ================================================================== */

describe("computeUsage KPIs on synthetic fixtures", () => {
  test("single-day fixture: 1-day window degrades comparison to null + reason, KPIs still exact", async () => {
    // fixtures/synthetic/single-day.json (jq-derived):
    //   one row 2026-06-15, totalCost 42.5075685, totalTokens 24680139,
    //   top model gpt-5.5 at 38.919999.
    const daily = await loadUnifiedDailyFixture("single-day.json");
    const window: DateRange = { from: "2026-06-15", to: "2026-06-15" };
    const dataset: MergedDataset = {
      hosts: [makeHost("solo", window, daily, {}, ["claude", "codex"])],
      agents: ["claude", "codex"],
      coverage: window,
    };
    const filter: UsageFilter = {
      from: "2026-06-15",
      to: "2026-06-15",
      hosts: null,
      agents: null,
    };
    const resp = computeUsage(dataset, filter, BOISE_OPTS);

    expect(resp.kpis.totalCost.value).toBeCloseTo(42.5075685, 8);
    expect(resp.kpis.totalTokens.value).toBe(24680139);
    expect(resp.kpis.activeDays.value).toBe(1);
    // 1 calendar day -> daily average === total.
    expect(resp.kpis.dailyAverageCost.value).toBeCloseTo(42.5075685, 8);
    expect(resp.kpis.mostExpensiveDay).toEqual({
      date: "2026-06-15",
      cost: 42.5075685,
    });
    expect(resp.kpis.topModel!.model).toBe("gpt-5.5");
    expect(resp.kpis.topModel!.cost).toBeCloseTo(38.919999, 8);
    // prev = 2026-06-14..2026-06-14, outside the 1-day coverage -> "—" semantics.
    for (const kpi of [
      resp.kpis.totalCost,
      resp.kpis.totalTokens,
      resp.kpis.dailyAverageCost,
      resp.kpis.activeDays,
    ]) {
      expect(kpi.comparison).toBeNull();
      expect(kpi.comparisonUnavailableReason).toBe("prior-period-not-covered");
    }
    // today = 2026-07-02 but the data has no July rows -> no MTD -> null.
    expect(resp.kpis.projectedMonthEnd).toBeNull();
  });

  test("zero-usage-gaps fixture: activeDays counts usage days (5), average divides by 28 calendar days", async () => {
    // fixtures/synthetic/zero-usage-gaps.json (jq-derived):
    //   5 rows in 2026-06-01..2026-06-28; totalCost 52.909979,
    //   totalTokens 31098007; max day 2026-06-09 at 27.87125.
    const daily = await loadUnifiedDailyFixture("zero-usage-gaps.json");
    const window: DateRange = { from: "2026-06-01", to: "2026-06-28" };
    const dataset: MergedDataset = {
      hosts: [makeHost("gappy", window, daily, {}, ["claude", "codex", "pi"])],
      agents: ["claude", "codex", "pi"],
      coverage: window,
    };
    const filter: UsageFilter = {
      from: "2026-06-01",
      to: "2026-06-28",
      hosts: null,
      agents: null,
    };
    const opts: ComputeUsageOptions = {
      today: "2026-06-28",
      timezone: "America/Boise",
    };
    const resp = computeUsage(dataset, filter, opts);

    expect(resp.kpis.totalCost.value).toBeCloseTo(52.909979, 8);
    expect(resp.kpis.totalTokens.value).toBe(31098007);
    expect(resp.kpis.activeDays.value).toBe(5); // NOT 28, NOT row count of axis
    // 52.909979 / 28 calendar days = 1.889642107142857 (NOT /5 = 10.58...).
    expect(resp.kpis.dailyAverageCost.value).toBeCloseTo(1.889642107142857, 10);
    expect(resp.kpis.mostExpensiveDay!.date).toBe("2026-06-09");
    expect(resp.kpis.mostExpensiveDay!.cost).toBeCloseTo(27.87125, 8);
    // June MTD on 2026-06-28 = 52.909979; 52.909979/28*30 = 56.68926321428571.
    expect(resp.kpis.projectedMonthEnd).not.toBeNull();
    expect(resp.kpis.projectedMonthEnd!.daysElapsed).toBe(28);
    expect(resp.kpis.projectedMonthEnd!.daysInMonth).toBe(30);
    expect(resp.kpis.projectedMonthEnd!.projectedCost).toBeCloseTo(56.68926321428571, 8);
    // prev = 2026-05-04..2026-05-31, before coverage -> null + reason.
    expect(resp.kpis.totalCost.comparison).toBeNull();
    expect(resp.kpis.totalCost.comparisonUnavailableReason).toBe(
      "prior-period-not-covered",
    );
  });

  test("empty dataset: all-zero KPIs, no NaN/Infinity, null extremes, null comparison with reason", () => {
    const dataset: MergedDataset = { hosts: [], agents: [], coverage: null };
    const filter: UsageFilter = {
      from: "2026-06-01",
      to: "2026-06-07",
      hosts: null,
      agents: null,
    };
    const resp = computeUsage(dataset, filter, BOISE_OPTS);

    expect(resp.kpis.totalCost.value).toBe(0);
    expect(resp.kpis.totalTokens.value).toBe(0);
    expect(resp.kpis.activeDays.value).toBe(0);
    expect(resp.kpis.dailyAverageCost.value).toBe(0); // 0/7, never NaN
    expect(Number.isFinite(resp.kpis.dailyAverageCost.value)).toBe(true);
    expect(resp.kpis.mostExpensiveDay).toBeNull();
    expect(resp.kpis.topModel).toBeNull();
    expect(resp.kpis.topHarness).toBeNull();
    expect(resp.kpis.projectedMonthEnd).toBeNull();
    // coverage null -> prior period can never be covered.
    expect(resp.kpis.totalCost.comparison).toBeNull();
    expect(resp.kpis.totalCost.comparisonUnavailableReason).toBe(
      "prior-period-not-covered",
    );
  });
});
