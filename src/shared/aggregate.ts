/**
 * THE core aggregator: MergedDataset + filter → UsageResponse (FR2/FR3/FR4).
 *
 * Global rules (PROMPT.md §7):
 *  - Pure and deterministic: `today` is injected via opts, Date.now() is
 *    never called. Same inputs → identical output.
 *  - Full-precision float math end to end; rounding happens ONLY in
 *    format.ts at display time.
 *  - Every time axis is the zero-filled inclusive from..to range.
 *  - Degrade with warnings (UsageResponse.warnings), never throw on odd data.
 *
 * Data-source selection (FR1/FR3 exact-vs-approximate):
 *  - HOST daily series & KPI totals with ALL agents selected: unified daily
 *    rows (authoritative).
 *  - Any HARNESS dimension, or KPI totals with an agent SUBSET: per-agent
 *    daily rows (exact per-harness series). For a selected agent with no
 *    agentDaily data on a host, fall back to that host's session rows for
 *    the agent, dated via sessionDateOf — approximate, add a warning.
 *  - MODEL stacks: with all agents selected, from unified modelBreakdowns
 *    (exact). With a subset, from the selected agents' agentDaily
 *    modelBreakdowns where the source has them; agents whose rows have
 *    modelBreakdowns === null (hermes) render as a single
 *    noModelDataKey(agent) band; series is exact:false with a note.
 */

import {
  MAX_USAGE_RANGE_DAYS,
  MIN_USAGE_FROM,
  noModelDataKey,
  noModelDataLabel,
  OTHER_MODELS_KEY,
  OTHER_MODELS_LABEL,
  TOP_MODELS_DEFAULT,
  TOP_SESSIONS_DEFAULT,
} from "./constants";
import {
  addDays,
  dateRangeInclusive,
  dayOfMonth,
  daysInMonth,
  diffDays,
  isValidDateString,
  isoToDateInTz,
  minDate,
  monthOf,
  monthToDateRange,
  previousPeriod,
} from "./dates";
import type {
  ComputeUsageOptions,
  CumulativeSeries,
  DailyStackedSeries,
  DateRange,
  DateString,
  KpiComparison,
  KpiValue,
  MergedDataset,
  MergedHostData,
  MonthProjection,
  ResolvedUsageFilter,
  SeriesKey,
  SessionRow,
  SessionTableRow,
  StackDimension,
  StackedPoint,
  TokenCompositionSeries,
  TokenCounts,
  UsageFilter,
  UsageKpis,
  UsageQuery,
  UsageResponse,
  UsageTables,
  UsageTotals,
} from "./types";

/* ------------------------------------------------------------------ */
/* Filter resolution                                                   */
/* ------------------------------------------------------------------ */

/** Comma list → trimmed, de-duplicated (order kept) array; null = "all". */
function parseIdList(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const items = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (items.length === 0) return null;
  return [...new Set(items)];
}

/**
 * Parse raw GET /api/usage query params into a UsageFilter. Returns
 * { ok:false, error } for malformed input; never throws.
 *
 * Hardening (the URL is hostile input — filter state is bookmarkable):
 *  - `to` after today is clamped to today (future days have no data;
 *    FR6 already defines omitted `to` = today).
 *  - `from` before MIN_USAGE_FROM is rejected (a 0001-01-01 axis would
 *    materialize ~740k zero-filled dates × 5 chart series and OOM the
 *    server; years < 100 also hit Date.UTC two-digit-year remapping).
 *  - Spans over MAX_USAGE_RANGE_DAYS are rejected.
 */
export function resolveUsageFilter(
  query: UsageQuery,
  today: DateString,
): { ok: true; filter: UsageFilter } | { ok: false; error: string } {
  let to = today;
  if (query.to !== undefined) {
    if (!isValidDateString(query.to)) {
      return { ok: false, error: `invalid 'to' date: ${query.to}` };
    }
    to = minDate(query.to, today); // clamp: no data exists after today
  }
  let from = addDays(today, -29); // default 30d preset
  if (query.from !== undefined) {
    if (!isValidDateString(query.from)) {
      return { ok: false, error: `invalid 'from' date: ${query.from}` };
    }
    from = query.from;
  }
  if (from < MIN_USAGE_FROM) {
    return {
      ok: false,
      error: `'from' (${from}) predates ${MIN_USAGE_FROM} — range is out of bounds`,
    };
  }
  if (from > to) {
    return { ok: false, error: `'from' (${from}) is after 'to' (${to})` };
  }
  if (diffDays(from, to) + 1 > MAX_USAGE_RANGE_DAYS) {
    return {
      ok: false,
      error: `date range ${from}..${to} spans more than ${MAX_USAGE_RANGE_DAYS} days`,
    };
  }
  return {
    ok: true,
    filter: {
      from,
      to,
      hosts: parseIdList(query.hosts),
      agents: parseIdList(query.agents),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Arithmetic primitives                                               */
/* ------------------------------------------------------------------ */

/** All-zero TokenCounts. */
export function emptyTokenCounts(): TokenCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
  };
}

/** All-zero UsageTotals. */
export function emptyUsageTotals(): UsageTotals {
  return { ...emptyTokenCounts(), cost: 0 };
}

/** Field-by-field sum (full precision). Pure — returns a new object. */
export function addTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationTokens: a.cacheCreationTokens + b.cacheCreationTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: a.cost + b.cost,
  };
}

/**
 * Generic zero-fill: one entry per date in `dates` (the axis), taking the
 * value from `byDate` when present, else `empty(date)`.
 */
export function zeroFillSeries<T>(
  dates: readonly DateString[],
  byDate: ReadonlyMap<DateString, T>,
  empty: (date: DateString) => T,
): T[] {
  return dates.map((d) => {
    const v = byDate.get(d);
    return v === undefined ? empty(d) : v;
  });
}

/* ------------------------------------------------------------------ */
/* KPI helpers (FR2)                                                   */
/* ------------------------------------------------------------------ */

/** deltaPercent is a FRACTION (0.18 = +18%); null when previous === 0. */
export function previousPeriodComparison(
  current: number,
  previous: number,
): KpiComparison {
  return {
    previousValue: previous,
    deltaAbsolute: current - previous,
    deltaPercent: previous === 0 ? null : (current - previous) / previous,
  };
}

/** FR2 coverage rule: range fully inside coverage; null coverage => false. */
export function isRangeCovered(
  range: DateRange,
  coverage: DateRange | null,
): boolean {
  if (coverage === null) return false;
  return coverage.from <= range.from && range.to <= coverage.to;
}

/** Naive linear month-end projection (FR2), all in config tz. */
export function projectMonthEnd(
  monthToDateCost: number,
  today: DateString,
): MonthProjection {
  const month = monthOf(today);
  const daysElapsed = dayOfMonth(today); // >= 1, never divides by zero
  const totalDays = daysInMonth(month);
  return {
    month,
    monthToDateCost,
    daysElapsed,
    daysInMonth: totalDays,
    projectedCost: (monthToDateCost / daysElapsed) * totalDays,
  };
}

/* ------------------------------------------------------------------ */
/* Model & session helpers (FR3/FR4)                                   */
/* ------------------------------------------------------------------ */

/** Top `n` models by cost (desc; ties by name asc) + the rest. */
export function topNModels(
  costByModel: ReadonlyMap<string, number>,
  n?: number,
): { top: string[]; other: string[] } {
  const limit = n ?? TOP_MODELS_DEFAULT;
  const names = [...costByModel.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .map(([name]) => name);
  return { top: names.slice(0, limit), other: names.slice(limit) };
}

const HERMES_ID_RE = /^(\d{4})(\d{2})(\d{2})_\d{6}_/;
const CODEX_ID_RE = /^(\d{4})\/(\d{2})\/(\d{2})\//;

/**
 * Best-effort calendar date (config tz) for a session row:
 *  1. metadata lastActivity (ISO) via isoToDateInTz;
 *  2. a date embedded in the session id (hermes / codex shapes);
 *  3. null. Never throws on garbage ids.
 */
export function sessionDateOf(
  row: SessionRow,
  timezone: string,
): DateString | null {
  if (row.lastActivity !== null) {
    const d = isoToDateInTz(row.lastActivity, timezone);
    if (d !== null) return d;
  }
  const hermes = HERMES_ID_RE.exec(row.sessionId);
  if (hermes !== null) {
    const date = `${hermes[1]!}-${hermes[2]!}-${hermes[3]!}`;
    if (isValidDateString(date)) return date;
  }
  const codex = CODEX_ID_RE.exec(row.sessionId);
  if (codex !== null) {
    const date = `${codex[1]!}-${codex[2]!}-${codex[3]!}`;
    if (isValidDateString(date)) return date;
  }
  return null;
}

/**
 * Case-insensitive substring search over sessionId AND projectPath (null
 * projectPath matches nothing). Empty/whitespace query => rows unchanged.
 */
export function filterSessionRows(
  rows: SessionTableRow[],
  search: string,
): SessionTableRow[] {
  const q = search.trim().toLowerCase();
  if (q.length === 0) return rows;
  return rows.filter(
    (r) =>
      r.sessionId.toLowerCase().includes(q) ||
      (r.projectPath !== null && r.projectPath.toLowerCase().includes(q)),
  );
}

/* ------------------------------------------------------------------ */
/* Internal aggregation context                                        */
/* ------------------------------------------------------------------ */

interface Ctx {
  dataset: MergedDataset;
  opts: ComputeUsageOptions;
  resolved: ResolvedUsageFilter;
  axis: DateString[];
  selectedHosts: MergedHostData[];
  /**
   * Intersection of the fetch windows of the hosts actually INCLUDED by the
   * filter (enabled ∩ hosts param). Drives the FR2 coverage rule — a
   * disabled host or one excluded by ?hosts= contributes no data, so its
   * (possibly stale) window must never suppress comparisons.
   */
  coverage: DateRange | null;
  /** Deduplicated human-readable degradation notes. */
  warnings: Set<string>;
}

/** Window intersection of the given hosts; null when none has a window. */
function hostsCoverage(hosts: readonly MergedHostData[]): DateRange | null {
  let coverage: DateRange | null = null;
  for (const h of hosts) {
    if (h.window === null) continue;
    if (coverage === null) {
      coverage = { from: h.window.from, to: h.window.to };
    } else {
      if (h.window.from > coverage.from) coverage.from = h.window.from;
      if (h.window.to < coverage.to) coverage.to = h.window.to;
    }
  }
  if (coverage !== null && coverage.from > coverage.to) return null;
  return coverage;
}

function makeCtx(
  dataset: MergedDataset,
  filter: UsageFilter,
  opts: ComputeUsageOptions,
): Ctx {
  const enabled = dataset.hosts.filter((h) => h.enabled);
  const hostSet = filter.hosts === null ? null : new Set(filter.hosts);
  const selectedHosts =
    hostSet === null ? enabled : enabled.filter((h) => hostSet.has(h.hostId));
  const allHosts =
    filter.hosts === null || enabled.every((h) => hostSet!.has(h.hostId));

  const observed = [...dataset.agents].sort();
  const agentSet = filter.agents === null ? null : new Set(filter.agents);
  const agents =
    agentSet === null
      ? observed
      : filter.agents!.filter((a) => observed.includes(a));
  const allAgents =
    filter.agents === null || observed.every((a) => agentSet!.has(a));

  const resolved: ResolvedUsageFilter = {
    from: filter.from,
    to: filter.to,
    hosts: selectedHosts.map((h) => h.hostId),
    agents,
    allHosts,
    allAgents,
  };
  return {
    dataset,
    opts,
    resolved,
    axis: dateRangeInclusive(filter.from, filter.to),
    selectedHosts,
    coverage: hostsCoverage(selectedHosts),
    warnings: new Set<string>(),
  };
}

function rowTotals(r: TokenCounts & { cost: number }): UsageTotals {
  return {
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheCreationTokens: r.cacheCreationTokens,
    cacheReadTokens: r.cacheReadTokens,
    totalTokens: r.totalTokens,
    cost: r.cost,
  };
}

function accumulate(
  map: Map<DateString, UsageTotals>,
  date: DateString,
  t: UsageTotals,
): void {
  const cur = map.get(date);
  if (cur === undefined) {
    map.set(date, { ...t });
  } else {
    cur.inputTokens += t.inputTokens;
    cur.outputTokens += t.outputTokens;
    cur.cacheCreationTokens += t.cacheCreationTokens;
    cur.cacheReadTokens += t.cacheReadTokens;
    cur.totalTokens += t.totalTokens;
    cur.cost += t.cost;
  }
}

/**
 * One host's contribution for one agent over [from..to]: agentDaily rows
 * when the host has them, else session-attributed fallback (approximate,
 * warned). Accumulates into `map`.
 */
function addAgentHostUsage(
  ctx: Ctx,
  host: MergedHostData,
  agent: string,
  from: DateString,
  to: DateString,
  map: Map<DateString, UsageTotals>,
): void {
  const rows = host.data.agentDaily[agent];
  if (rows !== undefined) {
    for (const row of rows) {
      if (row.date >= from && row.date <= to) accumulate(map, row.date, rowTotals(row));
    }
    return;
  }
  let used = false;
  for (const s of host.data.sessions) {
    if (s.agent !== agent) continue;
    const d = sessionDateOf(s, ctx.opts.timezone);
    if (d === null) {
      ctx.warnings.add(
        `Session "${s.sessionId}" (agent "${agent}", host "${host.hostId}") could not be dated; excluded from daily series.`,
      );
      continue;
    }
    if (d >= from && d <= to) {
      accumulate(map, d, rowTotals(s));
      used = true;
    }
  }
  if (used) {
    ctx.warnings.add(
      `Agent "${agent}" has no per-agent daily data on host "${host.hostId}"; using session-attributed data (approximate).`,
    );
  }
}

/** Per-day totals of one host under the active filter, over [from..to]. */
function hostDailyMap(
  ctx: Ctx,
  host: MergedHostData,
  from: DateString,
  to: DateString,
): Map<DateString, UsageTotals> {
  const map = new Map<DateString, UsageTotals>();
  if (ctx.resolved.allAgents) {
    for (const row of host.data.daily) {
      if (row.date >= from && row.date <= to) accumulate(map, row.date, rowTotals(row));
    }
  } else {
    for (const agent of ctx.resolved.agents) {
      addAgentHostUsage(ctx, host, agent, from, to, map);
    }
  }
  return map;
}

/** Combined per-day totals across all selected hosts, over [from..to]. */
function combinedMap(
  ctx: Ctx,
  from: DateString,
  to: DateString,
): Map<DateString, UsageTotals> {
  const map = new Map<DateString, UsageTotals>();
  for (const host of ctx.selectedHosts) {
    for (const [date, t] of hostDailyMap(ctx, host, from, to)) {
      accumulate(map, date, t);
    }
  }
  return map;
}

/** Per-agent per-day totals (agentDaily + session fallback), over [from..to]. */
function agentUsageMaps(
  ctx: Ctx,
  from: DateString,
  to: DateString,
): Map<string, Map<DateString, UsageTotals>> {
  const out = new Map<string, Map<DateString, UsageTotals>>();
  for (const agent of ctx.resolved.agents) {
    const map = new Map<DateString, UsageTotals>();
    for (const host of ctx.selectedHosts) {
      addAgentHostUsage(ctx, host, agent, from, to, map);
    }
    out.set(agent, map);
  }
  return out;
}

interface ModelAgg extends TokenCounts {
  cost: number;
  perDay: Map<DateString, number>;
}

interface ModelData {
  /** Per-model cost/token aggregation with per-day cost series. */
  perModel: Map<string, ModelAgg>;
  /** Per-agent "no model data" band cost per day (subset mode only). */
  bands: Map<string, Map<DateString, number>>;
}

function addModelCost(
  data: ModelData,
  modelName: string,
  date: DateString,
  bd: { cost: number; inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number },
): void {
  let agg = data.perModel.get(modelName);
  if (agg === undefined) {
    agg = { ...emptyTokenCounts(), cost: 0, perDay: new Map() };
    data.perModel.set(modelName, agg);
  }
  agg.cost += bd.cost;
  agg.inputTokens += bd.inputTokens;
  agg.outputTokens += bd.outputTokens;
  agg.cacheCreationTokens += bd.cacheCreationTokens;
  agg.cacheReadTokens += bd.cacheReadTokens;
  agg.totalTokens +=
    bd.inputTokens + bd.outputTokens + bd.cacheCreationTokens + bd.cacheReadTokens;
  agg.perDay.set(date, (agg.perDay.get(date) ?? 0) + bd.cost);
}

function addBandCost(
  data: ModelData,
  agent: string,
  date: DateString,
  cost: number,
): void {
  let band = data.bands.get(agent);
  if (band === undefined) {
    band = new Map();
    data.bands.set(agent, band);
  }
  band.set(date, (band.get(date) ?? 0) + cost);
}

/**
 * One host's model-dimension contribution for one agent (subset mode).
 * FR3 source selection ("from session-attributed model data where
 * available", band only when the source truly lacks model data):
 *  1. agentDaily rows whose modelBreakdowns carry cost →
 *     used directly; rows with modelBreakdowns === null (hermes) → band.
 *  2. agentDaily rows whose breakdowns exist but carry ZERO total cost
 *     while the rows themselves cost money (legacy/costless per-model
 *     placeholders) → prefer session-attributed model
 *     costs (codex unified-session rows DO carry real per-model costs).
 *     If the host has no datable sessions for the agent, degrade to a
 *     no-model-data band so the cost never silently collapses to $0.
 *  3. No agentDaily rows at all → session-attributed fallback (sessions
 *     without breakdowns band).
 */
function addAgentHostModelData(
  ctx: Ctx,
  host: MergedHostData,
  agent: string,
  from: DateString,
  to: DateString,
  data: ModelData,
): void {
  const rows = host.data.agentDaily[agent];
  const inRange = rows?.filter((r) => r.date >= from && r.date <= to);
  if (inRange !== undefined) {
    let breakdownCount = 0;
    let breakdownCost = 0;
    let rowCost = 0;
    for (const row of inRange) {
      rowCost += row.cost;
      if (row.modelBreakdowns !== null) {
        for (const bd of row.modelBreakdowns) {
          breakdownCount += 1;
          breakdownCost += bd.cost;
        }
      }
    }
    const costlessBreakdowns =
      breakdownCount > 0 && breakdownCost === 0 && rowCost !== 0;
    if (!costlessBreakdowns) {
      for (const row of inRange) {
        if (row.modelBreakdowns === null) {
          addBandCost(data, agent, row.date, row.cost);
        } else {
          for (const bd of row.modelBreakdowns) addModelCost(data, bd.modelName, row.date, bd);
        }
      }
      return;
    }
  }
  let usedSessions = false;
  for (const s of host.data.sessions) {
    if (s.agent !== agent) continue;
    const d = sessionDateOf(s, ctx.opts.timezone);
    if (d === null || d < from || d > to) continue;
    if (s.modelBreakdowns.length === 0) {
      addBandCost(data, agent, d, s.cost);
    } else {
      for (const bd of s.modelBreakdowns) addModelCost(data, bd.modelName, d, bd);
    }
    usedSessions = true;
  }
  if (inRange !== undefined) {
    // We got here via the legacy costless-breakdown path.
    ctx.warnings.add(
      `Agent "${agent}" daily model breakdowns carry no cost on host "${host.hostId}"; the model view uses session-attributed model costs (approximate).`,
    );
    if (!usedSessions) {
      for (const row of inRange) addBandCost(data, agent, row.date, row.cost);
    }
  }
}

/** Per-model aggregation per the FR3 source-selection rules. */
function modelData(ctx: Ctx, from: DateString, to: DateString): ModelData {
  const data: ModelData = { perModel: new Map(), bands: new Map() };
  if (ctx.resolved.allAgents) {
    for (const host of ctx.selectedHosts) {
      for (const row of host.data.daily) {
        if (row.date < from || row.date > to) continue;
        for (const bd of row.modelBreakdowns) addModelCost(data, bd.modelName, row.date, bd);
      }
    }
    return data;
  }
  for (const agent of ctx.resolved.agents) {
    for (const host of ctx.selectedHosts) {
      addAgentHostModelData(ctx, host, agent, from, to, data);
    }
  }
  return data;
}

/* ------------------------------------------------------------------ */
/* Series builders (FR3)                                               */
/* ------------------------------------------------------------------ */

function buildStackedPoints(
  axis: readonly DateString[],
  keys: readonly SeriesKey[],
  valueAt: (keyId: string, date: DateString) => number,
): StackedPoint[] {
  return axis.map((date) => {
    const values: Record<string, number> = {};
    let total = 0;
    for (const k of keys) {
      const v = valueAt(k.id, date);
      values[k.id] = v;
      total += v;
    }
    return { date, values, total };
  });
}

function sumCosts(map: ReadonlyMap<DateString, UsageTotals>): number {
  let s = 0;
  for (const t of map.values()) s += t.cost;
  return s;
}

function buildStackInternal(
  ctx: Ctx,
  dimension: StackDimension,
): DailyStackedSeries {
  const { from, to } = ctx.resolved;

  if (dimension === "host") {
    const perHost = ctx.selectedHosts.map((h) => ({
      id: h.hostId,
      label: h.label,
      map: hostDailyMap(ctx, h, from, to),
    }));
    const keys: SeriesKey[] = perHost
      .filter((h) => sumCosts(h.map) !== 0)
      .map((h) => ({ id: h.id, label: h.label, kind: "host" as const }));
    const byId = new Map(perHost.map((h) => [h.id, h.map]));
    return {
      dimension,
      keys,
      points: buildStackedPoints(ctx.axis, keys, (id, d) => byId.get(id)?.get(d)?.cost ?? 0),
      exact: true,
      note: null,
    };
  }

  if (dimension === "harness") {
    const maps = agentUsageMaps(ctx, from, to);
    const keys: SeriesKey[] = ctx.resolved.agents
      .filter((a) => sumCosts(maps.get(a) ?? new Map()) !== 0)
      .map((a) => ({ id: a, label: a, kind: "agent" as const }));
    return {
      dimension,
      keys,
      points: buildStackedPoints(ctx.axis, keys, (id, d) => maps.get(id)?.get(d)?.cost ?? 0),
      exact: true,
      note: null,
    };
  }

  // model dimension
  const data = modelData(ctx, from, to);
  const costByModel = new Map<string, number>();
  for (const [name, agg] of data.perModel) costByModel.set(name, agg.cost);
  const { top, other } = topNModels(costByModel, ctx.opts.topModels ?? TOP_MODELS_DEFAULT);

  const keys: SeriesKey[] = [];
  for (const name of top) {
    if ((costByModel.get(name) ?? 0) !== 0) {
      keys.push({ id: name, label: name, kind: "model" });
    }
  }
  const bandAgents = [...data.bands.keys()].sort();
  for (const agent of bandAgents) {
    let bandTotal = 0;
    for (const v of data.bands.get(agent)!.values()) bandTotal += v;
    if (bandTotal !== 0) {
      keys.push({
        id: noModelDataKey(agent),
        label: noModelDataLabel(agent),
        kind: "no-model-data",
      });
    }
  }
  const otherPerDay = new Map<DateString, number>();
  for (const name of other) {
    const agg = data.perModel.get(name)!;
    for (const [d, c] of agg.perDay) otherPerDay.set(d, (otherPerDay.get(d) ?? 0) + c);
  }
  let otherTotal = 0;
  for (const v of otherPerDay.values()) otherTotal += v;
  if (otherTotal !== 0) {
    keys.push({ id: OTHER_MODELS_KEY, label: OTHER_MODELS_LABEL, kind: "other" });
  }

  const exact = ctx.resolved.allAgents;
  const note = exact
    ? null
    : "Approximate: with a harness subset active, model stacks are built from per-agent model data; harnesses without per-day model data are shown as a single band, and segments need not sum to the KPI totals.";
  if (!exact) ctx.warnings.add(note!);

  const bandByKey = new Map<string, Map<DateString, number>>();
  for (const agent of bandAgents) bandByKey.set(noModelDataKey(agent), data.bands.get(agent)!);

  const points = buildStackedPoints(ctx.axis, keys, (id, d) => {
    if (id === OTHER_MODELS_KEY) return otherPerDay.get(d) ?? 0;
    const band = bandByKey.get(id);
    if (band !== undefined) return band.get(d) ?? 0;
    return data.perModel.get(id)?.perDay.get(d) ?? 0;
  });

  return { dimension, keys, points, exact, note };
}

/** Daily cost stacked by host/harness/model over the zero-filled axis. */
export function buildDailyStackedSeries(
  dataset: MergedDataset,
  filter: UsageFilter,
  dimension: StackDimension,
  opts: ComputeUsageOptions,
): DailyStackedSeries {
  return buildStackInternal(makeCtx(dataset, filter, opts), dimension);
}

function buildCumulativeInternal(ctx: Ctx): CumulativeSeries {
  const { from, to } = ctx.resolved;
  const perHost = ctx.selectedHosts.map((h) => ({
    id: h.hostId,
    map: hostDailyMap(ctx, h, from, to),
    running: 0,
  }));
  const points = ctx.axis.map((date) => {
    const byHost: Record<string, number> = {};
    let combined = 0;
    for (const h of perHost) {
      h.running += h.map.get(date)?.cost ?? 0;
      byHost[h.id] = h.running;
      combined += h.running;
    }
    return { date, byHost, combined };
  });
  return { hostIds: perHost.map((h) => h.id), points };
}

/** Cumulative cost lines: per filtered host + combined, monotone. */
export function buildCumulativeCostSeries(
  dataset: MergedDataset,
  filter: UsageFilter,
  opts: ComputeUsageOptions,
): CumulativeSeries {
  return buildCumulativeInternal(makeCtx(dataset, filter, opts));
}

function buildTokenCompositionInternal(ctx: Ctx): TokenCompositionSeries {
  const map = combinedMap(ctx, ctx.resolved.from, ctx.resolved.to);
  const points = ctx.axis.map((date) => {
    const t = map.get(date);
    return {
      date,
      inputTokens: t?.inputTokens ?? 0,
      outputTokens: t?.outputTokens ?? 0,
      cacheCreationTokens: t?.cacheCreationTokens ?? 0,
      cacheReadTokens: t?.cacheReadTokens ?? 0,
    };
  });
  return { points };
}

/** Token composition per day: the four visible classes, zero-filled. */
export function buildTokenComposition(
  dataset: MergedDataset,
  filter: UsageFilter,
  opts: ComputeUsageOptions,
): TokenCompositionSeries {
  return buildTokenCompositionInternal(makeCtx(dataset, filter, opts));
}

/* ------------------------------------------------------------------ */
/* Tables (FR4)                                                        */
/* ------------------------------------------------------------------ */

interface BreakdownSource {
  key: string;
  label: string;
  totals: UsageTotals;
  perDayCost: Map<DateString, number>;
}

function toBreakdownRows(
  sources: BreakdownSource[],
  grandTotalCost: number,
  axis: readonly DateString[],
) {
  return sources
    .filter((s) => s.totals.cost !== 0 || s.totals.totalTokens !== 0)
    .sort((a, b) => {
      if (b.totals.cost !== a.totals.cost) return b.totals.cost - a.totals.cost;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .map((s) => ({
      key: s.key,
      label: s.label,
      cost: s.totals.cost,
      inputTokens: s.totals.inputTokens,
      outputTokens: s.totals.outputTokens,
      cacheCreationTokens: s.totals.cacheCreationTokens,
      cacheReadTokens: s.totals.cacheReadTokens,
      totalTokens: s.totals.totalTokens,
      share: grandTotalCost === 0 ? 0 : s.totals.cost / grandTotalCost,
      sparkline: axis.map((d) => s.perDayCost.get(d) ?? 0),
    }));
}

function sumMap(map: ReadonlyMap<DateString, UsageTotals>): UsageTotals {
  let acc = emptyUsageTotals();
  for (const t of map.values()) acc = addTotals(acc, t);
  return acc;
}

function costPerDay(map: ReadonlyMap<DateString, UsageTotals>): Map<DateString, number> {
  const out = new Map<DateString, number>();
  for (const [d, t] of map) out.set(d, t.cost);
  return out;
}

function buildTablesInternal(ctx: Ctx, totalCost: number): UsageTables {
  const { from, to } = ctx.resolved;

  // byHost
  const hostSources: BreakdownSource[] = ctx.selectedHosts.map((h) => {
    const map = hostDailyMap(ctx, h, from, to);
    return {
      key: h.hostId,
      label: h.label,
      totals: sumMap(map),
      perDayCost: costPerDay(map),
    };
  });

  // byHarness
  const agentMaps = agentUsageMaps(ctx, from, to);
  const harnessSources: BreakdownSource[] = [...agentMaps.entries()].map(
    ([agent, map]) => ({
      key: agent,
      label: agent,
      totals: sumMap(map),
      perDayCost: costPerDay(map),
    }),
  );

  // byModel
  const data = modelData(ctx, from, to);
  const modelSources: BreakdownSource[] = [...data.perModel.entries()].map(
    ([name, agg]) => ({
      key: name,
      label: name,
      totals: {
        cost: agg.cost,
        inputTokens: agg.inputTokens,
        outputTokens: agg.outputTokens,
        cacheCreationTokens: agg.cacheCreationTokens,
        cacheReadTokens: agg.cacheReadTokens,
        totalTokens: agg.totalTokens,
      },
      perDayCost: agg.perDay,
    }),
  );

  // sessions
  const agentSet = new Set(ctx.resolved.agents);
  const sessionRows: SessionTableRow[] = [];
  for (const host of ctx.selectedHosts) {
    for (const s of host.data.sessions) {
      if (!ctx.resolved.allAgents && !agentSet.has(s.agent)) continue;
      const d = sessionDateOf(s, ctx.opts.timezone);
      if (d === null) {
        ctx.warnings.add(
          `Session "${s.sessionId}" (host "${host.hostId}") has no attributable date; included in the sessions table regardless of the date filter.`,
        );
      } else if (d < from || d > to) {
        continue;
      }
      sessionRows.push({
        sessionId: s.sessionId,
        hostId: host.hostId,
        agent: s.agent,
        models: s.modelsUsed,
        lastActivity: s.lastActivity,
        projectPath: s.projectPath,
        cost: s.cost,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheCreationTokens: s.cacheCreationTokens,
        cacheReadTokens: s.cacheReadTokens,
        totalTokens: s.totalTokens,
      });
    }
  }
  sessionRows.sort((a, b) => {
    if (b.cost !== a.cost) return b.cost - a.cost;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
  const cap = ctx.opts.topSessions ?? TOP_SESSIONS_DEFAULT;

  return {
    byHost: toBreakdownRows(hostSources, totalCost, ctx.axis),
    byHarness: toBreakdownRows(harnessSources, totalCost, ctx.axis),
    byModel: toBreakdownRows(modelSources, totalCost, ctx.axis),
    sessions: sessionRows.slice(0, cap),
  };
}

/** Breakdown tables + sessions table, all honoring the filter. */
export function buildBreakdownTables(
  dataset: MergedDataset,
  filter: UsageFilter,
  opts: ComputeUsageOptions,
): UsageTables {
  const ctx = makeCtx(dataset, filter, opts);
  const totalCost = sumCosts(combinedMap(ctx, ctx.resolved.from, ctx.resolved.to));
  return buildTablesInternal(ctx, totalCost);
}

/* ------------------------------------------------------------------ */
/* The entry point                                                     */
/* ------------------------------------------------------------------ */

interface RangeMetrics {
  cost: number;
  tokens: number;
  activeDays: number;
  dailyAverage: number;
}

function rangeMetrics(
  map: ReadonlyMap<DateString, UsageTotals>,
  calendarDays: number,
): RangeMetrics {
  let cost = 0;
  let tokens = 0;
  let activeDays = 0;
  for (const t of map.values()) {
    cost += t.cost;
    tokens += t.totalTokens;
    if (t.cost > 0) activeDays += 1;
  }
  return {
    cost,
    tokens,
    activeDays,
    dailyAverage: calendarDays > 0 ? cost / calendarDays : 0,
  };
}

/** Compute the complete UsageResponse — the single source of truth (FR6). */
export function computeUsage(
  dataset: MergedDataset,
  filter: UsageFilter,
  opts: ComputeUsageOptions,
): UsageResponse {
  const ctx = makeCtx(dataset, filter, opts);
  const { from, to } = ctx.resolved;
  const axisLen = ctx.axis.length;

  /* ----- totals & KPI metrics over the current range ----- */
  const current = combinedMap(ctx, from, to);
  const totals = sumMap(current);
  const cur = rangeMetrics(current, axisLen);

  /* ----- previous-period comparison (FR2 coverage rule) -----
   * Coverage is the window intersection of the hosts the filter actually
   * INCLUDES (ctx.coverage) — a disabled host, or one excluded via
   * ?hosts=, contributes no data and must not suppress comparisons with
   * its stale window. */
  const prevRange = previousPeriod({ from, to });
  const covered = isRangeCovered(prevRange, ctx.coverage);
  let prev: RangeMetrics | null = null;
  if (covered) {
    prev = rangeMetrics(combinedMap(ctx, prevRange.from, prevRange.to), axisLen);
  }
  const kpi = (value: number, previous: number | null): KpiValue =>
    previous === null
      ? {
          value,
          comparison: null,
          comparisonUnavailableReason: "prior-period-not-covered",
        }
      : {
          value,
          comparison: previousPeriodComparison(value, previous),
          comparisonUnavailableReason: null,
        };

  /* ----- extremes ----- */
  let mostExpensiveDay: { date: DateString; cost: number } | null = null;
  for (const [date, t] of [...current.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (t.cost > 0 && (mostExpensiveDay === null || t.cost > mostExpensiveDay.cost)) {
      mostExpensiveDay = { date, cost: t.cost };
    }
  }

  const mData = modelData(ctx, from, to);
  let topModel: { model: string; cost: number } | null = null;
  for (const [name, agg] of [...mData.perModel.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    if (topModel === null || agg.cost > topModel.cost) {
      topModel = { model: name, cost: agg.cost };
    }
  }

  const agentMaps = agentUsageMaps(ctx, from, to);
  let topHarness: { agent: string; cost: number } | null = null;
  for (const [agent, map] of agentMaps) {
    if (map.size === 0) continue;
    const cost = sumCosts(map);
    if (topHarness === null || cost > topHarness.cost) {
      topHarness = { agent, cost };
    }
  }

  /* ----- month-end projection (independent of from/to) -----
   * Coverage-gated on the FROM side only: when the fetched window starts
   * after the 1st, the "MTD" sum is window-clipped, not month-to-date —
   * suppress the projection (rendered as an em-dash) instead of showing a
   * silently-wrong number. coverage.to < today is fine (yesterday's
   * snapshot still covers the month start). */
  const mtd = monthToDateRange(opts.today);
  const mtdMap = combinedMap(ctx, mtd.from, mtd.to);
  const mtdCovered = ctx.coverage !== null && ctx.coverage.from <= mtd.from;
  let projectedMonthEnd: MonthProjection | null = null;
  if (mtdMap.size > 0) {
    if (mtdCovered) {
      projectedMonthEnd = projectMonthEnd(sumCosts(mtdMap), opts.today);
    } else {
      ctx.warnings.add(
        "Month-to-date is not fully covered by the fetched window; the month-end projection is unavailable.",
      );
    }
  }

  const kpis: UsageKpis = {
    totalCost: kpi(cur.cost, prev === null ? null : prev.cost),
    totalTokens: kpi(cur.tokens, prev === null ? null : prev.tokens),
    dailyAverageCost: kpi(cur.dailyAverage, prev === null ? null : prev.dailyAverage),
    activeDays: kpi(cur.activeDays, prev === null ? null : prev.activeDays),
    mostExpensiveDay,
    topModel,
    topHarness,
    projectedMonthEnd,
  };

  /* ----- charts & tables ----- */
  const charts = {
    dailyCostByHost: buildStackInternal(ctx, "host"),
    dailyCostByHarness: buildStackInternal(ctx, "harness"),
    dailyCostByModel: buildStackInternal(ctx, "model"),
    cumulativeCost: buildCumulativeInternal(ctx),
    tokenComposition: buildTokenCompositionInternal(ctx),
  };
  const tables = buildTablesInternal(ctx, cur.cost);

  /* ----- degraded hosts & failed sections surface as warnings ----- */
  for (const host of dataset.hosts) {
    if (host.error !== null) {
      ctx.warnings.add(
        `Host "${host.hostId}" is degraded (${host.error.kind}): ${host.error.message}`,
      );
    }
    for (const failure of host.sectionFailures ?? []) {
      ctx.warnings.add(`Host "${host.hostId}": ${failure}`);
    }
  }

  return {
    filter: ctx.resolved,
    timezone: opts.timezone,
    generatedAt: opts.generatedAt ?? `${opts.today}T00:00:00.000Z`,
    dateAxis: ctx.axis,
    totals,
    kpis,
    charts,
    tables,
    availableHosts: dataset.hosts.map((h) => ({
      id: h.hostId,
      label: h.label,
      color: h.color,
      enabled: h.enabled,
    })),
    availableAgents: [...dataset.agents].sort(),
    warnings: [...ctx.warnings],
  };
}
