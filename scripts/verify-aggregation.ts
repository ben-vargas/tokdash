/**
 * G4 gate: independent end-to-end verification of /api/usage aggregation.
 *
 * Run with the server already up (the gate runner starts/stops it):
 *
 *   MOCK=1 PORT=4114 bun start        # elsewhere, backgrounded
 *   PORT=4114 bun scripts/verify-aggregation.ts
 *
 * What it does, per PROMPT.md §8 G4:
 *   (a) fetches GET /api/usage for several from/to/hosts/agents combinations
 *       (all-hosts/all-agents, host subset, agent-filtered);
 *   (b) zod-validates each response against an INLINE schema of the FR6 wire
 *       contract (nothing imported from src/ — the check must not be circular);
 *   (c) independently recomputes expected totals with plain arithmetic
 *       straight from fixtures/real/<host>/unified.json, using top-level
 *       daily rows for host combos and `agents` slices for agent combos;
 *   (d) asserts |api − expected| ≤ $0.005 after rounding both to cents, plus
 *       sanity checks: zero-filled continuous axis of (to−from)+1 points on
 *       every series, and filtered-out hosts contributing exactly $0.
 *
 * Exits 1 on any failure; prints a per-combo PASS/FAIL report.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/* ---------------------------------------------------------------- */
/* Environment                                                       */
/* ---------------------------------------------------------------- */

const PORT = Number(process.env.PORT) || 4114;
const BASE = `http://127.0.0.1:${PORT}`;
const FIXTURES = join(import.meta.dir, "..", "fixtures", "real");
const ALL_HOSTS = ["local", "mm", "clawd"] as const;

/* ---------------------------------------------------------------- */
/* (b) Inline wire-contract schema — deliberately NOT imported from   */
/* src/shared. Field names per FR6 / the documented response shape.   */
/* ---------------------------------------------------------------- */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const finite = z.number().finite();

const tokenFields = {
  inputTokens: finite,
  outputTokens: finite,
  cacheCreationTokens: finite,
  cacheReadTokens: finite,
  totalTokens: finite,
};

const totalsSchema = z.object({ cost: finite, ...tokenFields });

const kpiValueSchema = z.object({
  value: finite,
  comparison: z
    .object({
      previousValue: finite,
      deltaAbsolute: finite,
      deltaPercent: finite.nullable(),
    })
    .nullable(),
  comparisonUnavailableReason: z.string().nullable(),
});

const stackedSeriesSchema = z.object({
  dimension: z.enum(["host", "harness", "model"]),
  keys: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(["host", "agent", "model", "other", "no-model-data"]),
    }),
  ),
  points: z.array(
    z.object({
      date: dateStr,
      values: z.record(z.string(), finite),
      total: finite,
    }),
  ),
  exact: z.boolean(),
  note: z.string().nullable(),
});

const breakdownRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  cost: finite,
  share: finite,
  sparkline: z.array(finite),
  ...tokenFields,
});

const usageResponseSchema = z.object({
  filter: z.object({
    from: dateStr,
    to: dateStr,
    hosts: z.array(z.string()),
    agents: z.array(z.string()),
    allHosts: z.boolean(),
    allAgents: z.boolean(),
  }),
  timezone: z.string().min(1),
  generatedAt: z.string().min(1),
  dateAxis: z.array(dateStr),
  totals: totalsSchema,
  kpis: z.object({
    totalCost: kpiValueSchema,
    totalTokens: kpiValueSchema,
    dailyAverageCost: kpiValueSchema,
    activeDays: kpiValueSchema,
    mostExpensiveDay: z.object({ date: dateStr, cost: finite }).nullable(),
    topModel: z.object({ model: z.string(), cost: finite }).nullable(),
    topHarness: z.object({ agent: z.string(), cost: finite }).nullable(),
    projectedMonthEnd: z
      .object({
        month: z.string().regex(/^\d{4}-\d{2}$/),
        monthToDateCost: finite,
        daysElapsed: finite,
        daysInMonth: finite,
        projectedCost: finite,
      })
      .nullable(),
  }),
  charts: z.object({
    dailyCostByHost: stackedSeriesSchema,
    dailyCostByHarness: stackedSeriesSchema,
    dailyCostByModel: stackedSeriesSchema,
    cumulativeCost: z.object({
      hostIds: z.array(z.string()),
      points: z.array(
        z.object({
          date: dateStr,
          byHost: z.record(z.string(), finite),
          combined: finite,
        }),
      ),
    }),
    tokenComposition: z.object({
      points: z.array(
        z.object({
          date: dateStr,
          inputTokens: finite,
          outputTokens: finite,
          cacheCreationTokens: finite,
          cacheReadTokens: finite,
        }),
      ),
    }),
  }),
  tables: z.object({
    byHost: z.array(breakdownRowSchema),
    byHarness: z.array(breakdownRowSchema),
    byModel: z.array(breakdownRowSchema),
    sessions: z.array(
      z.object({
        sessionId: z.string(),
        hostId: z.string(),
        agent: z.string(),
        models: z.array(z.string()),
        lastActivity: z.string().nullable(),
        projectPath: z.string().nullable(),
        cost: finite,
        ...tokenFields,
      }),
    ),
  }),
  availableHosts: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      color: z.string(),
      enabled: z.boolean(),
    }),
  ),
  availableAgents: z.array(z.string()),
  warnings: z.array(z.string()),
});

type UsageResponse = z.infer<typeof usageResponseSchema>;

/* ---------------------------------------------------------------- */
/* (c) Independent recompute — plain fs + JSON + arithmetic           */
/* ---------------------------------------------------------------- */

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Sum totalCost from unified daily fixture rows with period in [from,to]. */
function hostDailyCost(host: string, from: string, to: string): number {
  const doc = readJson(join(FIXTURES, host, "unified.json")) as {
    daily: Array<{ period: string; totalCost?: number }>;
  };
  let sum = 0;
  for (const row of doc.daily) {
    if (row.period >= from && row.period <= to) sum += row.totalCost ?? 0;
  }
  return sum;
}

/**
 * Sum cost from unified daily `agents` slices in [from,to].
 */
function agentDailyCost(
  host: string,
  agent: string,
  from: string,
  to: string,
): number {
  const doc = readJson(join(FIXTURES, host, "unified.json")) as {
    daily: Array<{
      period: string;
      agents?: Array<{ agent: string; totalCost?: number }>;
    }>;
  };
  let sum = 0;
  for (const row of doc.daily) {
    if (row.period < from || row.period > to) continue;
    sum += row.agents?.find((slice) => slice.agent === agent)?.totalCost ?? 0;
  }
  return sum;
}

/* ---------------------------------------------------------------- */
/* Assertion helpers                                                 */
/* ---------------------------------------------------------------- */

const roundCents = (x: number): number => Math.round(x * 100) / 100;

function inclusiveDayCount(from: string, to: string): number {
  const ms =
    Date.UTC(
      Number(to.slice(0, 4)),
      Number(to.slice(5, 7)) - 1,
      Number(to.slice(8, 10)),
    ) -
    Date.UTC(
      Number(from.slice(0, 4)),
      Number(from.slice(5, 7)) - 1,
      Number(from.slice(8, 10)),
    );
  return Math.round(ms / 86_400_000) + 1;
}

interface Combo {
  name: string;
  params: { from: string; to: string; hosts?: string; agents?: string };
  /** Independently computed expected total cost (full precision). */
  expected: () => number;
  /** Host ids that must contribute exactly $0. */
  excludedHosts: string[];
}

const combos: Combo[] = [
  {
    name: "C1 all hosts / all agents  2026-06-01..2026-07-01",
    params: { from: "2026-06-01", to: "2026-07-01" },
    expected: () =>
      ALL_HOSTS.reduce(
        (sum, h) => sum + hostDailyCost(h, "2026-06-01", "2026-07-01"),
        0,
      ),
    excludedHosts: [],
  },
  {
    name: "C2 host subset local,mm    2026-06-01..2026-06-30",
    params: { from: "2026-06-01", to: "2026-06-30", hosts: "local,mm" },
    expected: () =>
      hostDailyCost("local", "2026-06-01", "2026-06-30") +
      hostDailyCost("mm", "2026-06-01", "2026-06-30"),
    excludedHosts: ["clawd"],
  },
  {
    name: "C3 clawd + agent hermes    2026-06-01..2026-06-30",
    params: {
      from: "2026-06-01",
      to: "2026-06-30",
      hosts: "clawd",
      agents: "hermes",
    },
    expected: () => agentDailyCost("clawd", "hermes", "2026-06-01", "2026-06-30"),
    excludedHosts: ["local", "mm"],
  },
  {
    name: "C4 all hosts, agent claude 2026-06-10..2026-06-20",
    params: { from: "2026-06-10", to: "2026-06-20", agents: "claude" },
    expected: () =>
      ALL_HOSTS.reduce(
        (sum, h) => sum + agentDailyCost(h, "claude", "2026-06-10", "2026-06-20"),
        0,
      ),
    excludedHosts: [],
  },
];

/* ---------------------------------------------------------------- */
/* Runner                                                            */
/* ---------------------------------------------------------------- */

async function assertServerUp(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`GET /api/health returned ${res.status}`);
  } catch (err) {
    console.error(
      `FATAL: no TokDash server responding at ${BASE} (${String(err)}).\n` +
        `Start one first, e.g.:  MOCK=1 PORT=${PORT} bun start`,
    );
    process.exit(1);
  }
}

function checkCombo(combo: Combo, body: unknown): string[] {
  const failures: string[] = [];

  // (b) wire-contract validation with an inline schema.
  const parsed = usageResponseSchema.safeParse(body);
  if (!parsed.success) {
    failures.push(
      `response failed inline wire-schema validation: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
    return failures;
  }
  const r: UsageResponse = parsed.data;

  // (c)+(d) totals vs independent fixture arithmetic, compared in cents.
  const expected = combo.expected();
  const gotCents = roundCents(r.totals.cost);
  const expCents = roundCents(expected);
  if (Math.abs(gotCents - expCents) > 0.005) {
    failures.push(
      `totals.cost mismatch: api=${r.totals.cost} (=$${gotCents.toFixed(2)}) ` +
        `expected=${expected} (=$${expCents.toFixed(2)})`,
    );
  }
  if (roundCents(r.kpis.totalCost.value) !== gotCents) {
    failures.push(
      `kpis.totalCost.value (${r.kpis.totalCost.value}) != totals.cost (${r.totals.cost})`,
    );
  }

  // (d) zero-filled continuous axis: (to − from) + 1 points, everywhere.
  const days = inclusiveDayCount(combo.params.from, combo.params.to);
  const lengths: Array<[string, number]> = [
    ["dateAxis", r.dateAxis.length],
    ["charts.dailyCostByHost.points", r.charts.dailyCostByHost.points.length],
    ["charts.dailyCostByHarness.points", r.charts.dailyCostByHarness.points.length],
    ["charts.dailyCostByModel.points", r.charts.dailyCostByModel.points.length],
    ["charts.cumulativeCost.points", r.charts.cumulativeCost.points.length],
    ["charts.tokenComposition.points", r.charts.tokenComposition.points.length],
  ];
  for (const [label, len] of lengths) {
    if (len !== days) {
      failures.push(`${label} has ${len} points, expected ${days} (zero-filled axis)`);
    }
  }
  if (r.dateAxis[0] !== combo.params.from || r.dateAxis[r.dateAxis.length - 1] !== combo.params.to) {
    failures.push(
      `dateAxis spans ${r.dateAxis[0]}..${r.dateAxis[r.dateAxis.length - 1]}, ` +
        `expected ${combo.params.from}..${combo.params.to}`,
    );
  }
  for (const row of [...r.tables.byHost, ...r.tables.byHarness, ...r.tables.byModel]) {
    if (row.sparkline.length !== days) {
      failures.push(
        `sparkline for ${JSON.stringify(row.key)} has ${row.sparkline.length} entries, expected ${days}`,
      );
      break; // one report is enough
    }
  }

  // (d) filtered-out hosts contribute exactly $0.
  for (const hostId of combo.excludedHosts) {
    const tableRow = r.tables.byHost.find((row) => row.key === hostId);
    if (tableRow !== undefined && tableRow.cost !== 0) {
      failures.push(`excluded host ${hostId} shows cost ${tableRow.cost} in tables.byHost`);
    }
    const last = r.charts.cumulativeCost.points[r.charts.cumulativeCost.points.length - 1];
    const cum = last?.byHost[hostId] ?? 0;
    if (cum !== 0) {
      failures.push(`excluded host ${hostId} has cumulative cost ${cum}`);
    }
    for (const point of r.charts.dailyCostByHost.points) {
      const v = point.values[hostId] ?? 0;
      if (v !== 0) {
        failures.push(
          `excluded host ${hostId} contributes ${v} on ${point.date} in dailyCostByHost`,
        );
        break;
      }
    }
  }

  // Filter echo sanity: excluded hosts must not appear in the resolved filter.
  for (const hostId of combo.excludedHosts) {
    if (r.filter.hosts.includes(hostId)) {
      failures.push(`resolved filter.hosts unexpectedly includes excluded host ${hostId}`);
    }
  }

  return failures;
}

async function main(): Promise<void> {
  await assertServerUp();

  let failed = 0;
  for (const combo of combos) {
    const qs = new URLSearchParams(
      Object.entries(combo.params).filter(([, v]) => v !== undefined) as [string, string][],
    );
    const url = `${BASE}/api/usage?${qs.toString()}`;

    let body: unknown;
    let status = 0;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      status = res.status;
      body = await res.json();
    } catch (err) {
      console.error(`FAIL ${combo.name}\n     GET ${url} failed: ${String(err)}`);
      failed++;
      continue;
    }
    if (status !== 200) {
      console.error(`FAIL ${combo.name}\n     GET ${url} returned HTTP ${status}`);
      failed++;
      continue;
    }

    const failures = checkCombo(combo, body);
    const expected = combo.expected();
    const apiCost = (body as { totals?: { cost?: number } }).totals?.cost;
    if (failures.length === 0) {
      console.log(
        `PASS ${combo.name}\n` +
          `     api totals.cost=$${roundCents(apiCost ?? Number.NaN).toFixed(2)} ` +
          `(raw ${apiCost}) == fixtures $${roundCents(expected).toFixed(2)} (raw ${expected}); ` +
          `axis+series length OK; excluded hosts at $0: [${combo.excludedHosts.join(", ") || "n/a"}]`,
      );
    } else {
      failed++;
      console.error(`FAIL ${combo.name}`);
      for (const f of failures) console.error(`     - ${f}`);
    }
  }

  if (failed > 0) {
    console.error(`\nverify-aggregation: ${failed}/${combos.length} combos FAILED`);
    process.exit(1);
  }
  console.log(`\nverify-aggregation: all ${combos.length} combos passed`);
}

await main();
