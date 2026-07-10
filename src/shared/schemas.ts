/**
 * Zod v4 schemas for EVERY external boundary (PROMPT.md §7: treat every
 * external shape as hostile — validate, pass unknown fields through, prefer
 * degrade-with-warning over crash).
 *
 * Three schema families live here:
 *
 * 1. ccusage stdout (INPUT, hostile): permissive `z.looseObject` schemas with
 *    defaults. Report-level schemas keep rows as `unknown[]` on purpose — the
 *    normalizer validates ROW BY ROW so one bad row is skipped with a warning
 *    instead of failing the whole payload.
 * 2. tokdash.config.json + cached snapshots (INPUT, semi-trusted): validated
 *    with explicit shapes; unknown keys are stripped, not rejected.
 * 3. API requests/responses (OUR wire format): schemas annotated with
 *    `z.ZodType<T>` against the interfaces in ./types so schema and type can
 *    never drift.
 */

import { z } from "zod";
import { AGENT_NAME_RE, DATE_RE, HEX_COLOR_RE, MONTH_RE, TZ_RE } from "./constants";
import type {
  ApiErrorResponse,
  AppConfig,
  BreakdownRow,
  CommandRecord,
  ConfigPutResponse,
  CumulativeSeries,
  DailyStackedSeries,
  HostConfig,
  HostDailyRow,
  HostRef,
  HostSnapshot,
  HostStatus,
  HostUsageData,
  KpiValue,
  ModelBreakdown,
  MonthProjection,
  MonthlyRow,
  NormalizeWarning,
  RefreshResponse,
  ResolvedUsageFilter,
  SeriesKey,
  SessionRow,
  SessionTableRow,
  StatusResponse,
  TestConnectionResponse,
  TokenCompositionSeries,
  UsageKpis,
  UsageResponse,
  UsageTotals,
  AgentDailyRow,
  HostError,
} from "./types";

/* ================================================================== */
/* 1. ccusage stdout contracts (hostile input, permissive)             */
/* ================================================================== */

/** Finite number guard — ccusage never emits NaN/Infinity, but stdin is hostile. */
const num = z.number().refine(Number.isFinite, "must be finite");

/** A numeric field that defaults to 0 when absent. */
const num0 = num.default(0);

/**
 * `totals` object of any unified/per-agent report. Cost may arrive as
 * `totalCost` (unified/claude/hermes) or `costUSD` (codex) — both optional
 * here; the normalizer coalesces.
 */
export const ccusageTotalsSchema = z.looseObject({
  inputTokens: num0,
  outputTokens: num0,
  cacheCreationTokens: num0,
  cacheReadTokens: num0,
  totalTokens: num0,
  totalCost: num.optional(),
  costUSD: num.optional(),
});
export type CcusageTotals = z.infer<typeof ccusageTotalsSchema>;

/** One entry of unified `modelBreakdowns`. */
export const ccusageModelBreakdownSchema = z.looseObject({
  modelName: z.string().min(1),
  cost: num0,
  inputTokens: num0,
  outputTokens: num0,
  cacheCreationTokens: num0,
  cacheReadTokens: num0,
});

/** One per-agent slice emitted by unified `--by-agent` daily/monthly rows. */
export const unifiedAgentSliceSchema = z.looseObject({
  agent: z.string().min(1),
  totalCost: num0,
  totalTokens: num0,
  inputTokens: num0,
  outputTokens: num0,
  cacheCreationTokens: num0,
  cacheReadTokens: num0,
  modelsUsed: z.array(z.string()).default([]),
  modelBreakdowns: z.array(ccusageModelBreakdownSchema).default([]),
});

/**
 * Unified `daily`/`monthly` row: date lives in `period` (NO `date` field),
 * `agent` is the literal "all", real agents are in `metadata.agents`.
 * `metadata` is nullish (may be entirely absent).
 */
export const unifiedDailyRowSchema = z.looseObject({
  period: z.string().regex(DATE_RE),
  agent: z.string().default("all"),
  totalCost: num0,
  totalTokens: num0,
  inputTokens: num0,
  outputTokens: num0,
  cacheCreationTokens: num0,
  cacheReadTokens: num0,
  metadata: z
    .looseObject({ agents: z.array(z.string()).default([]) })
    .nullish(),
  modelsUsed: z.array(z.string()).default([]),
  modelBreakdowns: z.array(ccusageModelBreakdownSchema).default([]),
  agents: z.array(unifiedAgentSliceSchema).optional(),
});

/** Unified monthly row — identical to daily but `period` is YYYY-MM. */
export const unifiedMonthlyRowSchema = unifiedDailyRowSchema.extend({
  period: z.string().regex(MONTH_RE),
});

/**
 * Unified `session` row: `period` = session id (shape varies by harness),
 * `agent` = real harness name. `metadata` is OPTIONAL/nullish for ALL agents
 * (live-verified absent on hermes, droid, AND gemini rows) and permissive
 * (pi adds projectPath, codex adds reasoningOutputTokens).
 */
export const unifiedSessionRowSchema = z.looseObject({
  period: z.string().min(1),
  agent: z.string().min(1),
  totalCost: num0,
  totalTokens: num0,
  inputTokens: num0,
  outputTokens: num0,
  cacheCreationTokens: num0,
  cacheReadTokens: num0,
  metadata: z
    .looseObject({
      lastActivity: z.string().optional(),
      projectPath: z.string().optional(),
      reasoningOutputTokens: num.optional(),
    })
    .nullish(),
  modelsUsed: z.array(z.string()).default([]),
  modelBreakdowns: z.array(ccusageModelBreakdownSchema).default([]),
});

/**
 * Report envelopes. Rows stay `unknown[]` — the normalizer validates each
 * row individually (skip+warn), so one malformed row cannot reject the file.
 */
export const unifiedDailyReportSchema = z.looseObject({
  daily: z.array(z.unknown()),
  totals: z.unknown().optional(),
});
export const unifiedMonthlyReportSchema = z.looseObject({
  monthly: z.array(z.unknown()),
  totals: z.unknown().optional(),
});
/** NOTE: top-level key is `session` — SINGULAR (live-verified). */
export const unifiedSessionReportSchema = z.looseObject({
  session: z.array(z.unknown()),
  totals: z.unknown().optional(),
});

/** The single multi-section output contract used for every host refresh. */
export const unifiedEnvelopeSchema = z.looseObject({
  daily: z.array(z.unknown()),
  monthly: z.array(z.unknown()),
  session: z.array(z.unknown()),
  totals: z.unknown(),
});

/* ================================================================== */
/* 2. Config file & cached snapshots                                   */
/* ================================================================== */

const piJsonlSourceConfigSchema = z.object({
  type: z.literal("pi-jsonl"),
  agent: z.string().min(1).regex(AGENT_NAME_RE),
  path: z.string().min(1).refine((value) => !/[\x00-\x1F\x7F]/u.test(value), {
    message: "path must not contain control characters",
  }),
});

export const hostConfigSchema: z.ZodType<HostConfig> = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1),
  color: z.string().regex(HEX_COLOR_RE),
  enabled: z.boolean(),
  ssh: z.string().min(1).nullable(),
  ccusageCmd: z.string().min(1),
  extraSources: z.array(piJsonlSourceConfigSchema).optional(),
});

export const appConfigSchema: z.ZodType<AppConfig> = z.object({
  timezone: z.string().regex(TZ_RE),
  fetchWindowDays: z.number().int().min(1).max(3660),
  refreshIntervalMinutes: z.number().int().min(1).max(1440),
  hosts: z.array(hostConfigSchema),
});

/* --------------------- normalized-data schemas ---------------------- */
/* Validate .cache/snapshots/<hostId>.json on read (an external file).   */

export const dateRangeSchema = z.object({
  from: z.string().regex(DATE_RE),
  to: z.string().regex(DATE_RE),
});

export const modelBreakdownSchema: z.ZodType<ModelBreakdown> = z.object({
  modelName: z.string(),
  cost: num,
  inputTokens: num,
  outputTokens: num,
  cacheCreationTokens: num,
  cacheReadTokens: num,
});

const tokenCountsShape = {
  inputTokens: num,
  outputTokens: num,
  cacheCreationTokens: num,
  cacheReadTokens: num,
  totalTokens: num,
} as const;

export const usageTotalsSchema: z.ZodType<UsageTotals> = z.object({
  ...tokenCountsShape,
  cost: num,
});

export const hostDailyRowSchema: z.ZodType<HostDailyRow> = z.object({
  ...tokenCountsShape,
  date: z.string().regex(DATE_RE),
  cost: num,
  agents: z.array(z.string()),
  modelsUsed: z.array(z.string()),
  modelBreakdowns: z.array(modelBreakdownSchema),
});

export const monthlyRowSchema: z.ZodType<MonthlyRow> = z.object({
  ...tokenCountsShape,
  month: z.string().regex(MONTH_RE),
  cost: num,
  agents: z.array(z.string()),
  modelsUsed: z.array(z.string()),
  modelBreakdowns: z.array(modelBreakdownSchema),
});

export const agentDailyRowSchema: z.ZodType<AgentDailyRow> = z.object({
  ...tokenCountsShape,
  agent: z.string(),
  date: z.string().regex(DATE_RE),
  cost: num,
  modelsUsed: z.array(z.string()),
  modelBreakdowns: z.array(modelBreakdownSchema).nullable(),
  messageCount: num.nullable(),
  reasoningOutputTokens: num.nullable(),
  dialect: z.literal("unified"),
});

export const sessionRowSchema: z.ZodType<SessionRow> = z.object({
  ...tokenCountsShape,
  sessionId: z.string(),
  agent: z.string(),
  cost: num,
  modelsUsed: z.array(z.string()),
  modelBreakdowns: z.array(modelBreakdownSchema),
  lastActivity: z.string().nullable(),
  projectPath: z.string().nullable(),
});

export const hostUsageDataSchema: z.ZodType<HostUsageData> = z.object({
  daily: z.array(hostDailyRowSchema),
  monthly: z.array(monthlyRowSchema),
  sessions: z.array(sessionRowSchema),
  agentDaily: z.record(z.string(), z.array(agentDailyRowSchema)),
  agents: z.array(z.string()),
});

export const normalizeWarningSchema: z.ZodType<NormalizeWarning> = z.object({
  code: z.enum([
    "row-skipped",
    "unknown-dialect",
    "unknown-agent",
    "missing-field",
    "section-failed",
    "totals-missing",
  ]),
  message: z.string(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const hostErrorKindSchema = z.enum([
  "unreachable",
  "timeout",
  "exit",
  "bad-json",
  "schema",
  "unknown",
]);

export const hostErrorSchema: z.ZodType<HostError> = z.object({
  kind: hostErrorKindSchema,
  message: z.string(),
  exitCode: z.number().nullable(),
  stderrTail: z.string(),
  at: z.string(),
});

export const commandRecordSchema: z.ZodType<CommandRecord> = z.object({
  name: z.string(),
  argv: z.array(z.string()),
  exitCode: z.number().nullable(),
  durationMs: z.number(),
  bytes: z.number(),
  stderrTail: z.string(),
  timedOut: z.boolean(),
});

export const hostSnapshotSchema: z.ZodType<HostSnapshot> = z.object({
  hostId: z.string().min(1),
  fetchedAt: z.string(),
  timezone: z.string(),
  window: dateRangeSchema,
  commands: z.array(commandRecordSchema),
  raw: z.object({ unified: z.string().nullable() }),
  data: hostUsageDataSchema,
  warnings: z.array(normalizeWarningSchema),
  error: hostErrorSchema.nullable(),
});

/* ================================================================== */
/* 3. API wire schemas (FR6)                                           */
/* ================================================================== */

/* ------------------------------ requests --------------------------- */

/** GET /api/usage query params (raw, before resolveUsageFilter). */
export const usageQuerySchema = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
  /** Comma-separated host ids; omitted = all. */
  hosts: z.string().optional(),
  /** Comma-separated agent names; omitted = all. */
  agents: z.string().optional(),
});

/** PUT /api/config body — the whole document, validated then atomically rewritten. */
export const configPutRequestSchema = appConfigSchema;

/* ------------------------------ responses -------------------------- */

export const configPutResponseSchema: z.ZodType<ConfigPutResponse> = z.object({
  ok: z.literal(true),
  config: appConfigSchema,
});

export const apiErrorResponseSchema: z.ZodType<ApiErrorResponse> = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});

export const refreshResponseSchema: z.ZodType<RefreshResponse> = z.object({
  started: z.boolean(),
  alreadyRunning: z.boolean(),
});

export const hostStatusSchema: z.ZodType<HostStatus> = z.object({
  hostId: z.string(),
  label: z.string(),
  color: z.string(),
  enabled: z.boolean(),
  freshness: z.enum(["fresh", "stale", "error", "never"]),
  fetchedAt: z.string().nullable(),
  ageMs: z.number().nullable(),
  refreshing: z.boolean(),
  durations: z.array(z.object({ name: z.string(), durationMs: z.number() })),
  agents: z.array(z.string()),
  error: z
    .object({
      kind: hostErrorKindSchema,
      message: z.string(),
      stderrTail: z.string(),
    })
    .nullable(),
});

export const statusResponseSchema: z.ZodType<StatusResponse> = z.object({
  refreshing: z.boolean(),
  generatedAt: z.string(),
  hosts: z.array(hostStatusSchema),
});

export const testConnectionResponseSchema: z.ZodType<TestConnectionResponse> =
  z.object({
    ok: z.boolean(),
    hostId: z.string(),
    roundTripMs: z.number(),
    ccusageVersion: z.string().nullable(),
    detectedAgents: z.array(z.string()),
    exitCode: z.number().nullable(),
    stderrTail: z.string(),
    error: z.string().nullable(),
  });

/* --------------------- /api/usage response tree --------------------- */

export const resolvedUsageFilterSchema: z.ZodType<ResolvedUsageFilter> =
  z.object({
    from: z.string().regex(DATE_RE),
    to: z.string().regex(DATE_RE),
    hosts: z.array(z.string()),
    agents: z.array(z.string()),
    allHosts: z.boolean(),
    allAgents: z.boolean(),
  });

export const kpiComparisonSchema = z.object({
  previousValue: num,
  deltaAbsolute: num,
  deltaPercent: num.nullable(),
});

export const kpiValueSchema: z.ZodType<KpiValue> = z.object({
  value: num,
  comparison: kpiComparisonSchema.nullable(),
  comparisonUnavailableReason: z.literal("prior-period-not-covered").nullable(),
});

export const monthProjectionSchema: z.ZodType<MonthProjection> = z.object({
  month: z.string().regex(MONTH_RE),
  monthToDateCost: num,
  daysElapsed: z.number().int().min(1).max(31),
  daysInMonth: z.number().int().min(28).max(31),
  projectedCost: num,
});

export const usageKpisSchema: z.ZodType<UsageKpis> = z.object({
  totalCost: kpiValueSchema,
  totalTokens: kpiValueSchema,
  dailyAverageCost: kpiValueSchema,
  activeDays: kpiValueSchema,
  mostExpensiveDay: z
    .object({ date: z.string().regex(DATE_RE), cost: num })
    .nullable(),
  topModel: z.object({ model: z.string(), cost: num }).nullable(),
  topHarness: z.object({ agent: z.string(), cost: num }).nullable(),
  projectedMonthEnd: monthProjectionSchema.nullable(),
});

export const seriesKeySchema: z.ZodType<SeriesKey> = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["host", "agent", "model", "other", "no-model-data"]),
});

export const stackedPointSchema = z.object({
  date: z.string().regex(DATE_RE),
  values: z.record(z.string(), num),
  total: num,
});

export const dailyStackedSeriesSchema: z.ZodType<DailyStackedSeries> =
  z.object({
    dimension: z.enum(["host", "harness", "model"]),
    keys: z.array(seriesKeySchema),
    points: z.array(stackedPointSchema),
    exact: z.boolean(),
    note: z.string().nullable(),
  });

export const cumulativeSeriesSchema: z.ZodType<CumulativeSeries> = z.object({
  hostIds: z.array(z.string()),
  points: z.array(
    z.object({
      date: z.string().regex(DATE_RE),
      byHost: z.record(z.string(), num),
      combined: num,
    }),
  ),
});

export const tokenCompositionSeriesSchema: z.ZodType<TokenCompositionSeries> =
  z.object({
    points: z.array(
      z.object({
        date: z.string().regex(DATE_RE),
        inputTokens: num,
        outputTokens: num,
        cacheCreationTokens: num,
        cacheReadTokens: num,
      }),
    ),
  });

export const breakdownRowSchema: z.ZodType<BreakdownRow> = z.object({
  ...tokenCountsShape,
  key: z.string(),
  label: z.string(),
  cost: num,
  share: num,
  sparkline: z.array(num),
});

export const sessionTableRowSchema: z.ZodType<SessionTableRow> = z.object({
  ...tokenCountsShape,
  sessionId: z.string(),
  hostId: z.string(),
  agent: z.string(),
  models: z.array(z.string()),
  lastActivity: z.string().nullable(),
  projectPath: z.string().nullable(),
  cost: num,
});

export const hostRefSchema: z.ZodType<HostRef> = z.object({
  id: z.string(),
  label: z.string(),
  color: z.string(),
  enabled: z.boolean(),
});

export const usageResponseSchema: z.ZodType<UsageResponse> = z.object({
  filter: resolvedUsageFilterSchema,
  timezone: z.string(),
  generatedAt: z.string(),
  dateAxis: z.array(z.string().regex(DATE_RE)),
  totals: usageTotalsSchema,
  kpis: usageKpisSchema,
  charts: z.object({
    dailyCostByHost: dailyStackedSeriesSchema,
    dailyCostByHarness: dailyStackedSeriesSchema,
    dailyCostByModel: dailyStackedSeriesSchema,
    cumulativeCost: cumulativeSeriesSchema,
    tokenComposition: tokenCompositionSeriesSchema,
  }),
  tables: z.object({
    byHost: z.array(breakdownRowSchema),
    byHarness: z.array(breakdownRowSchema),
    byModel: z.array(breakdownRowSchema),
    sessions: z.array(sessionTableRowSchema),
  }),
  availableHosts: z.array(hostRefSchema),
  availableAgents: z.array(z.string()),
  warnings: z.array(z.string()),
});
