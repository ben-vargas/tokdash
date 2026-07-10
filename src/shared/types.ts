/**
 * TokDash shared domain + API wire types.
 *
 * This module is types-only (no runtime code). It is the single source of
 * truth for every shape that crosses a module or process boundary:
 *   - normalized ccusage data (per host, per agent, per session),
 *   - host snapshots persisted to .cache/snapshots/<hostId>.json,
 *   - tokdash.config.json,
 *   - every /api/* request/response (FR6).
 *
 * Ground-truth notes baked into these types (PROMPT.md §2.3, verified live):
 *   - `totalTokens` is AUTHORITATIVE and frequently LARGER than the sum of the
 *     four visible token classes (reasoning/other buckets are folded in).
 *     Never assume totalTokens === input+output+cacheCreation+cacheRead.
 *   - Session `metadata` can be entirely absent for ANY agent (observed for
 *     hermes, droid, gemini) — normalized as nullable fields, never required.
 *   - Costs are unrounded floats; aggregate in full precision, round only in
 *     the formatting layer.
 *   - Model names are opaque labels ("[pi] claude-opus-4.6", "glm-5.2:cloud",
 *     "hf:zai-org/GLM-5.2") — never parse them or use as CSS/DOM identifiers.
 */

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/** Calendar date string, `YYYY-MM-DD`, always in the configured report tz. */
export type DateString = string;

/** Calendar month string, `YYYY-MM`. */
export type MonthString = string;

/** Inclusive date range; `from <= to`, both `YYYY-MM-DD`. */
export interface DateRange {
  from: DateString;
  to: DateString;
}

/** UI date-range presets (FR1). `Nd` = today plus the N-1 preceding days. */
export type DatePreset = "today" | "7d" | "14d" | "30d" | "60d" | "90d" | "mtd";

/**
 * The four visible token classes plus the authoritative total.
 * `totalTokens` >= sum of the four classes (may be strictly greater).
 */
export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
}

/** Token counts plus cost in USD (full-precision float, never pre-rounded). */
export interface UsageTotals extends TokenCounts {
  cost: number;
}

/**
 * Per-model cost/token breakdown (normalized from unified `modelBreakdowns`
 * and from the codex `models` object). No `totalTokens` here — ccusage does
 * not report an authoritative per-model total on unified rows.
 */
export interface ModelBreakdown {
  /** Opaque model label; may contain spaces, brackets, colons, slashes. */
  modelName: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/* ------------------------------------------------------------------ */
/* Normalized ccusage rows (output of src/shared/normalize.ts)         */
/* ------------------------------------------------------------------ */

/** Provenance marker for normalized per-agent daily rows. */
export type AgentDailyDialect = "unified";

/**
 * One normalized unified-daily row for one host and one day.
 * Source: unified `ccusage daily --json` (rows keyed by `period`).
 * This is the AUTHORITATIVE per-day total when all harnesses are selected.
 */
export interface HostDailyRow extends TokenCounts {
  /** From the raw row's `period` field. */
  date: DateString;
  /** From `totalCost`. */
  cost: number;
  /** From `metadata.agents`; `[]` when metadata was absent. */
  agents: string[];
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
}

/** One normalized unified-monthly row. Source: `ccusage monthly --json`. */
export interface MonthlyRow extends TokenCounts {
  /** From the raw row's `period` field (`YYYY-MM`). */
  month: MonthString;
  cost: number;
  agents: string[];
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
}

/**
 * One normalized per-agent daily row. Source: an `agents` slice on a unified
 * daily envelope row.
 */
export interface AgentDailyRow extends TokenCounts {
  /** The harness this row belongs to (adapter input, not from the row). */
  agent: string;
  date: DateString;
  /** From the slice's `totalCost`. */
  cost: number;
  modelsUsed: string[];
  /**
   * Per-model breakdowns supplied by the unified `--by-agent` slice.
   */
  modelBreakdowns: ModelBreakdown[] | null;
  /** Retained for the stable normalized shape; always null. */
  messageCount: number | null;
  /** Retained for the stable normalized shape; always null. */
  reasoningOutputTokens: number | null;
  /** Fixed provenance marker for the unified envelope path. */
  dialect: AgentDailyDialect;
}

/**
 * One normalized session row. Source: unified `ccusage session --json`
 * (top-level key `session`, singular).
 */
export interface SessionRow extends TokenCounts {
  /** From the raw row's `period` field — a session id whose shape varies by harness. */
  sessionId: string;
  /** Real harness name (`claude`, `hermes`, `pi`, ... or unknown strings). */
  agent: string;
  cost: number;
  modelsUsed: string[];
  modelBreakdowns: ModelBreakdown[];
  /** ISO timestamp from `metadata.lastActivity`; null when metadata absent (hermes/droid/gemini...). */
  lastActivity: string | null;
  /** From pi's `metadata.projectPath`; null elsewhere. */
  projectPath: string | null;
}

/** All normalized data for one host (one fetch cycle). */
export interface HostUsageData {
  daily: HostDailyRow[];
  monthly: MonthlyRow[];
  sessions: SessionRow[];
  /** Keyed by agent id; exact per-harness daily series (FR1/FR3). */
  agentDaily: Record<string, AgentDailyRow[]>;
  /**
   * Union of agents observed ANYWHERE in this host's data: session `agent`
   * fields, daily `metadata.agents`, and `agentDaily` keys. Includes unknown
   * (non-allowlisted) harness names — they must surface as chips, not vanish.
   */
  agents: string[];
}

/* ------------------------------------------------------------------ */
/* Normalization results & warnings                                    */
/* ------------------------------------------------------------------ */

export type NormalizeWarningCode =
  | "row-skipped" // a row failed validation and was dropped (degrade, don't crash)
  | "unknown-dialect" // retained for cached/wire compatibility; unified fetches do not emit it
  | "unknown-agent" // an agent name outside KNOWN_HARNESSES was observed
  | "missing-field" // a field was absent and a default/derivation was substituted
  | "section-failed" // an entire section (e.g. session stdout) failed to parse
  | "totals-missing"; // report had no usable `totals` object

export interface NormalizeWarning {
  code: NormalizeWarningCode;
  /** Human-readable, includes enough context to debug (host/agent/row hints). */
  message: string;
  /** Optional structured context (e.g. { agent, index, issue }). */
  context?: Record<string, unknown>;
}

/**
 * Result of parsing one raw stdout payload. `ok: false` is reserved for
 * payload-level failures (malformed JSON, wrong top-level shape); individual
 * bad ROWS never fail the payload — they are skipped with a warning.
 */
export type ParseResult<T> =
  | { ok: true; value: T; warnings: NormalizeWarning[] }
  | { ok: false; error: string; warnings: NormalizeWarning[] };

/** Result of normalizing one row. `row: null` means skipped (warnings say why). */
export interface RowResult<T> {
  row: T | null;
  warnings: NormalizeWarning[];
}

export interface NormalizedUnifiedDaily {
  rows: HostDailyRow[];
  /** ccusage's own `totals` object, normalized; null if absent/unusable. */
  totals: UsageTotals | null;
}

export interface NormalizedUnifiedMonthly {
  rows: MonthlyRow[];
  totals: UsageTotals | null;
}

export interface NormalizedUnifiedSession {
  rows: SessionRow[];
  totals: UsageTotals | null;
}

/** Raw stdout captured for the one unified invocation on a host. */
export interface HostRawSections {
  /** Extracted JSON envelope; null when the invocation did not yield data. */
  unified: string | null;
}

/* ------------------------------------------------------------------ */
/* Host snapshots (.cache/snapshots/<hostId>.json)                     */
/* ------------------------------------------------------------------ */

export type HostErrorKind =
  | "unreachable" // ssh exit 255 / connect failure
  | "timeout"
  | "exit" // non-zero ccusage exit (e.g. 2 = arg parse, 127 = not found)
  | "bad-json" // stdout was not parseable JSON
  | "schema" // parsed but top-level shape unusable
  | "unknown";

export interface HostError {
  kind: HostErrorKind;
  message: string;
  exitCode: number | null;
  /** Last portion of stderr (stderr is never merged into stdout). */
  stderrTail: string;
  /** ISO timestamp when the error occurred. */
  at: string;
}

/** Execution record for one ccusage invocation (mirrors fixtures/real/&lt;host&gt;/manifest.json). */
export interface CommandRecord {
  /** `unified` for refreshes, `version` for connection tests. */
  name: string;
  argv: string[];
  exitCode: number | null;
  durationMs: number;
  /** stdout byte length. */
  bytes: number;
  stderrTail: string;
  timedOut: boolean;
}

/**
 * One host's persisted snapshot: raw stdout + normalized data + fetch
 * bookkeeping. A failed refresh NEVER discards the previous snapshot; the
 * server keeps serving the last good one with `error` set (stale-while-revalidate).
 */
export interface HostSnapshot {
  hostId: string;
  /** ISO timestamp of the fetch that produced `data`. */
  fetchedAt: string;
  /** Report timezone every ccusage call was pinned to (`-z`). */
  timezone: string;
  /** The --since/--until window this snapshot covers (inclusive). */
  window: DateRange;
  commands: CommandRecord[];
  raw: HostRawSections;
  data: HostUsageData;
  warnings: NormalizeWarning[];
  /** null = last refresh fully succeeded; set = degraded (data may be stale). */
  error: HostError | null;
}

/* ------------------------------------------------------------------ */
/* Config (tokdash.config.json)                                        */
/* ------------------------------------------------------------------ */

/**
 * An EXTRA pi-format store declared to ccusage through its config file. The
 * user-facing shape remains unchanged for backward compatibility.
 */
export interface PiJsonlSourceConfig {
  type: "pi-jsonl";
  /** Named-store agent emitted by ccusage. */
  agent: string;
  /** Filesystem path on the host written into the temporary ccusage config. */
  path: string;
}

export type HostSourceConfig = PiJsonlSourceConfig;

export interface HostConfig {
  /** Stable id used in filters, snapshots, series keys. */
  id: string;
  /** Display label. */
  label: string;
  /** Hex color `#rrggbb`; this host's series color everywhere. */
  color: string;
  enabled: boolean;
  /** SSH alias from ~/.ssh/config; null = execute locally. */
  ssh: string | null;
  /** Trusted shell prefix (the config file is the security boundary). */
  ccusageCmd: string;
  /** Extra data sources merged into this host's data (absent/[] = none). */
  extraSources?: HostSourceConfig[];
}

export interface AppConfig {
  /** IANA timezone, e.g. "America/Boise". Passed as `-z` to every ccusage call. */
  timezone: string;
  /** Trailing fetch window in days (default 90). */
  fetchWindowDays: number;
  /** Auto-refresh interval in minutes (default 15). */
  refreshIntervalMinutes: number;
  hosts: HostConfig[];
}

/* ------------------------------------------------------------------ */
/* Merge layer (src/shared/merge.ts)                                   */
/* ------------------------------------------------------------------ */

/** Input to mergeHosts: a configured host plus its latest snapshot (or none). */
export interface HostMergeInput {
  host: HostConfig;
  /** null = never fetched (no cache yet). */
  snapshot: HostSnapshot | null;
}

export interface MergedHostData {
  hostId: string;
  label: string;
  color: string;
  enabled: boolean;
  /** Empty HostUsageData when snapshot was null. */
  data: HostUsageData;
  fetchedAt: string | null;
  error: HostError | null;
  /** The snapshot's fetch window; null when never fetched. */
  window: DateRange | null;
  /**
   * Human-readable `section-failed` messages from the snapshot's
   * normalization (e.g. one per-agent daily section that did not parse
   * while the rest of the refresh succeeded). Surfaced by computeUsage as
   * UsageResponse warnings so a section-level degradation is never
   * invisible. Optional: hand-built datasets (tests) may omit it.
   */
  sectionFailures?: string[];
}

/**
 * The merged multi-host dataset the aggregator consumes. Hosts stay
 * SEPARATE here (they are independent — the same date on two hosts is two
 * distinct facts that ADD, never dedup); cross-host summation happens in
 * aggregate.ts / combinedDailyTotals.
 */
export interface MergedDataset {
  hosts: MergedHostData[];
  /** Union of observed agents across all hosts, sorted ascending. */
  agents: string[];
  /**
   * Intersection of the fetch windows of all hosts that HAVE a snapshot
   * (the conservative range for which every fetched host has data).
   * null when no host has been fetched. Used for the FR2
   * "previous period not fully covered => null comparison" rule.
   */
  coverage: DateRange | null;
}

/* ------------------------------------------------------------------ */
/* Usage filter & aggregation (src/shared/aggregate.ts)                */
/* ------------------------------------------------------------------ */

/** Raw query params of GET /api/usage (all optional, comma lists). */
export interface UsageQuery {
  /** Inclusive YYYY-MM-DD; omitted => default 30d window ending today. */
  from?: string;
  /** Inclusive YYYY-MM-DD; omitted => today (config tz). */
  to?: string;
  /** Comma-separated host ids; omitted => all hosts. */
  hosts?: string;
  /** Comma-separated agent names; omitted => all agents. */
  agents?: string;
}

/** Parsed filter. null host/agent list = "all" (no restriction). */
export interface UsageFilter {
  from: DateString;
  to: DateString;
  hosts: string[] | null;
  agents: string[] | null;
}

/** Filter echoed in UsageResponse, resolved against the dataset. */
export interface ResolvedUsageFilter {
  from: DateString;
  to: DateString;
  /** Concrete host ids included (filter ∩ configured enabled hosts). */
  hosts: string[];
  /** Concrete agent names included (filter ∩ observed agents). */
  agents: string[];
  /** True when the filter did not restrict hosts (null or superset). */
  allHosts: boolean;
  /** True when the filter did not restrict agents. Drives exact-vs-approximate (FR3). */
  allAgents: boolean;
}

export interface ComputeUsageOptions {
  /** "Today" as YYYY-MM-DD in the config tz — ALWAYS injected, never Date.now(). */
  today: DateString;
  /** IANA config timezone (informational echo + session date attribution). */
  timezone: string;
  /** ISO timestamp stamped into the response; defaults to `${today}T00:00:00.000Z`. */
  generatedAt?: string;
  /** Top-N models before "other" bucketing; default TOP_MODELS_DEFAULT (8). */
  topModels?: number;
  /** Max session rows returned; default TOP_SESSIONS_DEFAULT (100). */
  topSessions?: number;
}

/* ---------------------------- KPIs (FR2) --------------------------- */

export interface KpiComparison {
  previousValue: number;
  /** current - previous, full precision. */
  deltaAbsolute: number;
  /**
   * (current - previous) / previous as a FRACTION (0.18 = +18%).
   * null when previousValue === 0 (undefined ratio).
   */
  deltaPercent: number | null;
}

export type ComparisonUnavailableReason = "prior-period-not-covered";

export interface KpiValue {
  value: number;
  /** null when the comparison could not be computed (see reason). */
  comparison: KpiComparison | null;
  /** Set iff comparison is null because coverage was insufficient. */
  comparisonUnavailableReason: ComparisonUnavailableReason | null;
}

/** Naive linear month-end projection (FR2), computed in the config tz. */
export interface MonthProjection {
  /** YYYY-MM of `today`. */
  month: MonthString;
  /** Cost accrued from the 1st of `month` through `today` (filtered hosts/agents; NOT date-filtered). */
  monthToDateCost: number;
  /** Day-of-month of `today` (1-based). */
  daysElapsed: number;
  daysInMonth: number;
  /** monthToDateCost / daysElapsed * daysInMonth, full precision. */
  projectedCost: number;
}

export interface UsageKpis {
  totalCost: KpiValue;
  totalTokens: KpiValue;
  /** total cost / calendar days in range (zero-filled denominator, not active days). */
  dailyAverageCost: KpiValue;
  /** Count of days in range with cost > 0. */
  activeDays: KpiValue;
  /** null when the filtered range has no usage. */
  mostExpensiveDay: { date: DateString; cost: number } | null;
  /** Top model by cost within the filter; null when no model data. */
  topModel: { model: string; cost: number } | null;
  /** Top harness by cost within the filter; null when no usage. */
  topHarness: { agent: string; cost: number } | null;
  /** null when no month-to-date data for the filtered hosts/agents. */
  projectedMonthEnd: MonthProjection | null;
}

/* --------------------------- Charts (FR3) --------------------------- */

export type StackDimension = "host" | "harness" | "model";

export interface SeriesKey {
  /**
   * Stable key used in StackedPoint.values. host => host id; harness =>
   * agent name; model => opaque model name, or OTHER_MODELS_KEY, or
   * noModelDataKey(agent) for harnesses without per-day model data.
   */
  id: string;
  /** Display label (host label / agent name / model name / "Other" / "<agent> — no model data"). */
  label: string;
  kind: "host" | "agent" | "model" | "other" | "no-model-data";
}

export interface StackedPoint {
  date: DateString;
  /** Cost per SeriesKey.id. Every key present on every point (0 when absent). */
  values: Record<string, number>;
  /** Sum of values, full precision. */
  total: number;
}

export interface DailyStackedSeries {
  dimension: StackDimension;
  /** Ordered stack keys (bottom to top). */
  keys: SeriesKey[];
  /** Zero-filled: one point per date in the inclusive from..to axis. */
  points: StackedPoint[];
  /**
   * true when segment sums are authoritative. false only for the model
   * dimension with a harness subset active (FR3 approximate rule) — then
   * segments need not sum exactly to the KPI totals.
   */
  exact: boolean;
  /** Human-readable caveat when exact === false (or other degradations); else null. */
  note: string | null;
}

export interface CumulativePoint {
  date: DateString;
  /** Running cost per host id (only filtered hosts appear). */
  byHost: Record<string, number>;
  combined: number;
}

export interface CumulativeSeries {
  /** Host ids present in byHost, in availableHosts order. */
  hostIds: string[];
  /** Zero-filled, monotonically non-decreasing. */
  points: CumulativePoint[];
}

export interface TokenCompositionPoint {
  date: DateString;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface TokenCompositionSeries {
  /** Zero-filled. */
  points: TokenCompositionPoint[];
}

export interface UsageCharts {
  dailyCostByHost: DailyStackedSeries;
  dailyCostByHarness: DailyStackedSeries;
  dailyCostByModel: DailyStackedSeries;
  cumulativeCost: CumulativeSeries;
  tokenComposition: TokenCompositionSeries;
}

/* --------------------------- Tables (FR4) --------------------------- */

export interface BreakdownRow extends TokenCounts {
  /** host id / agent name / model name (or OTHER_MODELS_KEY). */
  key: string;
  label: string;
  cost: number;
  /** cost / filtered total cost, as a FRACTION 0..1; 0 when total is 0. */
  share: number;
  /** Daily cost aligned 1:1 with UsageResponse.dateAxis (zero-filled). */
  sparkline: number[];
}

export interface SessionTableRow extends TokenCounts {
  sessionId: string;
  hostId: string;
  agent: string;
  models: string[];
  /** ISO timestamp or null (metadata-less harnesses). */
  lastActivity: string | null;
  projectPath: string | null;
  cost: number;
}

export interface UsageTables {
  byHost: BreakdownRow[];
  byHarness: BreakdownRow[];
  byModel: BreakdownRow[];
  /** Top `topSessions` (default 100) by cost within the filter, desc. */
  sessions: SessionTableRow[];
}

/* ------------------------- Usage response --------------------------- */

/** Configured host reference for UI chips (always ALL configured hosts). */
export interface HostRef {
  id: string;
  label: string;
  color: string;
  enabled: boolean;
}

/**
 * THE single source of truth the UI renders (FR6). Fully derived from the
 * merged snapshot dataset by computeUsage — the browser never re-aggregates.
 */
export interface UsageResponse {
  filter: ResolvedUsageFilter;
  timezone: string;
  generatedAt: string;
  /** Inclusive, continuous, zero-filled from..to date axis (YYYY-MM-DD asc). */
  dateAxis: DateString[];
  /** Full-precision totals for the active filter. */
  totals: UsageTotals;
  kpis: UsageKpis;
  charts: UsageCharts;
  tables: UsageTables;
  /** All configured hosts (chips), regardless of filter. */
  availableHosts: HostRef[];
  /** All agents observed anywhere in the data (chips), sorted asc. */
  availableAgents: string[];
  /** Human-readable degradation notes (approximate mode, undated sessions, host errors...). */
  warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Remaining API wire types (FR6)                                      */
/* ------------------------------------------------------------------ */

/** GET /api/config → the current AppConfig verbatim. */
export type ConfigGetResponse = AppConfig;

/** PUT /api/config request body: a complete AppConfig document. */
export type ConfigPutRequest = AppConfig;

/** PUT /api/config success response. */
export interface ConfigPutResponse {
  ok: true;
  /** The validated config as persisted. */
  config: AppConfig;
}

/** POST /api/refresh — responds immediately; refreshes are single-flight. */
export interface RefreshResponse {
  /** true if a new refresh was started by this request. */
  started: boolean;
  /** true if a refresh was already in flight (this request joined it). */
  alreadyRunning: boolean;
}

export type HostFreshness =
  | "fresh" // snapshot age <= staleAfterMs(refreshIntervalMinutes)
  | "stale" // has a snapshot, but older than that
  | "error" // last refresh failed (data may still be served stale)
  | "never"; // no snapshot yet

export interface HostStatus {
  hostId: string;
  label: string;
  color: string;
  enabled: boolean;
  freshness: HostFreshness;
  fetchedAt: string | null;
  /** Milliseconds since fetchedAt at response time; null when never fetched. */
  ageMs: number | null;
  /** true while this host's fetch is in flight. */
  refreshing: boolean;
  /** Per-command durations of the last completed fetch. */
  durations: { name: string; durationMs: number }[];
  /** Agents observed on this host. */
  agents: string[];
  error: { kind: HostErrorKind; message: string; stderrTail: string } | null;
}

/** GET /api/status */
export interface StatusResponse {
  /** true while any host refresh is in flight. */
  refreshing: boolean;
  generatedAt: string;
  hosts: HostStatus[];
}

/** POST /api/hosts/:id/test */
export interface TestConnectionResponse {
  ok: boolean;
  hostId: string;
  roundTripMs: number;
  /** Parsed from `ccusage --version` stdout (e.g. "20.0.16"); null on failure. */
  ccusageVersion: string | null;
  /** Agents detected on the host (best effort); [] on failure. */
  detectedAgents: string[];
  exitCode: number | null;
  stderrTail: string;
  /** null on success; human-readable reason on failure. */
  error: string | null;
}

/** Error envelope for every non-2xx API response. */
export interface ApiErrorResponse {
  error: string;
  details?: unknown;
}
