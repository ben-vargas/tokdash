/**
 * Unified-envelope normalizers: raw ccusage stdout → normalized rows.
 *
 * Contract (PROMPT.md §7 — hostile input, degrade over crash):
 *  - NOTHING in this module throws on bad input. Malformed JSON or an
 *    unusable top-level shape => `{ ok: false, error }` ParseResult.
 *  - Individual bad ROWS never fail a payload: they are skipped and a
 *    `row-skipped` warning is emitted.
 *  - `totalTokens` is copied verbatim (authoritative), NEVER recomputed from
 *    the four token classes. If absent, the class sum is substituted as a
 *    floor and a `missing-field` warning is emitted.
 *  - Costs are kept full precision, never rounded.
 *
 * Pure functions only — no I/O, no Date.now().
 */

import { KNOWN_HARNESS_SET } from "./constants";
import {
  ccusageTotalsSchema,
  unifiedAgentSliceSchema,
  unifiedDailyReportSchema,
  unifiedDailyRowSchema,
  unifiedEnvelopeSchema,
  unifiedMonthlyReportSchema,
  unifiedMonthlyRowSchema,
  unifiedSessionReportSchema,
  unifiedSessionRowSchema,
} from "./schemas";
import type {
  AgentDailyRow,
  HostDailyRow,
  HostUsageData,
  ModelBreakdown,
  MonthlyRow,
  NormalizeWarning,
  NormalizedUnifiedDaily,
  NormalizedUnifiedMonthly,
  NormalizedUnifiedSession,
  ParseResult,
  RowResult,
  SessionRow,
  UsageTotals,
} from "./types";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function warn(
  code: NormalizeWarning["code"],
  message: string,
  context?: Record<string, unknown>,
): NormalizeWarning {
  return context === undefined ? { code, message } : { code, message, context };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Was the field literally present on the raw payload (vs schema default)? */
function hasField(raw: unknown, key: string): boolean {
  return isPlainObject(raw) && key in raw;
}

/**
 * pi-format adapters tag model labels with their store name (`[pi] ...`,
 * `[omp] ...`). Store provenance already exists on the harness dimension, so
 * strip any prefix allowed by ccusage's named-store grammar.
 */
const STORE_LABEL_PREFIX_RE = /^\[[a-z][a-z0-9_-]{0,31}\] /;

function stripStoreLabel(label: string): string {
  return label.replace(STORE_LABEL_PREFIX_RE, "");
}

/** Bare-slug modelsUsed; dedupes labels that collapse after stripping. */
function stripModelsUsed(list: readonly string[]): string[] {
  return [...new Set(list.map(stripStoreLabel))];
}

/**
 * Strip loose-schema extras down to the exact ModelBreakdown shape, with
 * labels bare-slugged; entries whose names collapse after stripping (e.g.
 * "[pi] gpt-5.5" + codex's "gpt-5.5" on one unified row) merge by summing.
 */
function mapBreakdowns(
  list: ReadonlyArray<{
    modelName: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }>,
): ModelBreakdown[] {
  const byName = new Map<string, ModelBreakdown>();
  for (const b of list) {
    const modelName = stripStoreLabel(b.modelName);
    const cur = byName.get(modelName);
    if (cur === undefined) {
      byName.set(modelName, {
        modelName,
        cost: b.cost,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        cacheCreationTokens: b.cacheCreationTokens,
        cacheReadTokens: b.cacheReadTokens,
      });
    } else {
      cur.cost += b.cost;
      cur.inputTokens += b.inputTokens;
      cur.outputTokens += b.outputTokens;
      cur.cacheCreationTokens += b.cacheCreationTokens;
      cur.cacheReadTokens += b.cacheReadTokens;
    }
  }
  return [...byName.values()];
}

/**
 * Authoritative totalTokens: copied verbatim when the raw row carried it,
 * else class-sum floor + missing-field warning appended to `warnings`.
 */
function authoritativeTotalTokens(
  raw: unknown,
  parsedTotal: number,
  classSum: number,
  warnings: NormalizeWarning[],
  where: string,
): number {
  if (hasField(raw, "totalTokens")) return parsedTotal;
  warnings.push(
    warn(
      "missing-field",
      `${where}: totalTokens absent; substituted the 4-class sum ${classSum} as a floor`,
    ),
  );
  return classSum;
}

/* ------------------------------------------------------------------ */
/* JSON + totals                                                       */
/* ------------------------------------------------------------------ */

/** Safe JSON.parse — `{ ok: false }` (never an exception) on malformed input. */
export function safeParseJson(stdout: string): ParseResult<unknown> {
  try {
    return { ok: true, value: JSON.parse(stdout) as unknown, warnings: [] };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      warnings: [],
    };
  }
}

/**
 * Normalize a ccusage `totals` object (unified or per-agent; totalCost or
 * costUSD). Returns null when `raw` is not a usable object.
 */
export function normalizeCcusageTotals(raw: unknown): UsageTotals | null {
  const parsed = ccusageTotalsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const t = parsed.data;
  return {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    cacheReadTokens: t.cacheReadTokens,
    totalTokens: t.totalTokens,
    cost: t.totalCost ?? t.costUSD ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Unified row normalizers                                             */
/* ------------------------------------------------------------------ */

/** Normalize one unified daily row. row:null = skipped. */
export function normalizeUnifiedDailyRow(raw: unknown): RowResult<HostDailyRow> {
  const parsed = unifiedDailyRowSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      row: null,
      warnings: [
        warn("row-skipped", `unified daily row skipped: ${parsed.error.message}`),
      ],
    };
  }
  const d = parsed.data;
  const warnings: NormalizeWarning[] = [];
  const classSum =
    d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens;
  const totalTokens = authoritativeTotalTokens(
    raw,
    d.totalTokens,
    classSum,
    warnings,
    `unified daily row ${d.period}`,
  );
  return {
    row: {
      date: d.period,
      cost: d.totalCost,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheCreationTokens: d.cacheCreationTokens,
      cacheReadTokens: d.cacheReadTokens,
      totalTokens,
      agents: d.metadata?.agents ?? [],
      modelsUsed: stripModelsUsed(d.modelsUsed),
      modelBreakdowns: mapBreakdowns(d.modelBreakdowns),
    },
    warnings,
  };
}

/** Normalize one unified monthly row. */
export function normalizeUnifiedMonthlyRow(raw: unknown): RowResult<MonthlyRow> {
  const parsed = unifiedMonthlyRowSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      row: null,
      warnings: [
        warn("row-skipped", `unified monthly row skipped: ${parsed.error.message}`),
      ],
    };
  }
  const d = parsed.data;
  const warnings: NormalizeWarning[] = [];
  const classSum =
    d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens;
  const totalTokens = authoritativeTotalTokens(
    raw,
    d.totalTokens,
    classSum,
    warnings,
    `unified monthly row ${d.period}`,
  );
  return {
    row: {
      month: d.period,
      cost: d.totalCost,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheCreationTokens: d.cacheCreationTokens,
      cacheReadTokens: d.cacheReadTokens,
      totalTokens,
      agents: d.metadata?.agents ?? [],
      modelsUsed: stripModelsUsed(d.modelsUsed),
      modelBreakdowns: mapBreakdowns(d.modelBreakdowns),
    },
    warnings,
  };
}

/** Normalize one unified session row. */
export function normalizeUnifiedSessionRow(
  raw: unknown,
  expectedAgents: ReadonlySet<string> = KNOWN_HARNESS_SET,
): RowResult<SessionRow> {
  const parsed = unifiedSessionRowSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      row: null,
      warnings: [
        warn("row-skipped", `unified session row skipped: ${parsed.error.message}`),
      ],
    };
  }
  const d = parsed.data;
  const warnings: NormalizeWarning[] = [];
  if (!expectedAgents.has(d.agent)) {
    warnings.push(
      warn("unknown-agent", `unknown harness "${d.agent}" observed in session data`, {
        agent: d.agent,
      }),
    );
  }
  const classSum =
    d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens;
  const totalTokens = authoritativeTotalTokens(
    raw,
    d.totalTokens,
    classSum,
    warnings,
    `session row ${d.period}`,
  );
  return {
    row: {
      sessionId: d.period,
      agent: d.agent,
      cost: d.totalCost,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheCreationTokens: d.cacheCreationTokens,
      cacheReadTokens: d.cacheReadTokens,
      totalTokens,
      modelsUsed: stripModelsUsed(d.modelsUsed),
      modelBreakdowns: mapBreakdowns(d.modelBreakdowns),
      lastActivity: d.metadata?.lastActivity ?? null,
      projectPath: d.metadata?.projectPath ?? null,
    },
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Unified report parsers                                              */
/* ------------------------------------------------------------------ */

/** Shared envelope→rows plumbing for the three unified report shapes. */
function parseUnifiedReport<TRow>(
  stdout: string,
  envelope: (v: unknown) => { rows: unknown[]; totals: unknown } | null,
  normalizeRow: (raw: unknown) => RowResult<TRow>,
): ParseResult<{ rows: TRow[]; totals: UsageTotals | null }> {
  const json = safeParseJson(stdout);
  if (!json.ok) return { ok: false, error: json.error, warnings: [] };
  const env = envelope(json.value);
  if (env === null) {
    return {
      ok: false,
      error: "payload does not match the expected report envelope",
      warnings: [],
    };
  }
  const warnings: NormalizeWarning[] = [];
  const rows: TRow[] = [];
  for (const raw of env.rows) {
    const r = normalizeRow(raw);
    warnings.push(...r.warnings);
    if (r.row !== null) rows.push(r.row);
  }
  const totals = normalizeCcusageTotals(env.totals);
  if (totals === null) {
    warnings.push(
      warn("totals-missing", "report has no usable `totals` object"),
    );
  }
  return { ok: true, value: { rows, totals }, warnings };
}

/** Parse + validate + normalize unified `ccusage daily --json` stdout. */
export function parseUnifiedDaily(
  stdout: string,
): ParseResult<NormalizedUnifiedDaily> {
  return parseUnifiedReport(
    stdout,
    (v) => {
      const p = unifiedDailyReportSchema.safeParse(v);
      return p.success ? { rows: p.data.daily, totals: p.data.totals } : null;
    },
    normalizeUnifiedDailyRow,
  );
}

/** Parse unified `ccusage monthly --json` stdout (top-level key `monthly`). */
export function parseUnifiedMonthly(
  stdout: string,
): ParseResult<NormalizedUnifiedMonthly> {
  return parseUnifiedReport(
    stdout,
    (v) => {
      const p = unifiedMonthlyReportSchema.safeParse(v);
      return p.success ? { rows: p.data.monthly, totals: p.data.totals } : null;
    },
    normalizeUnifiedMonthlyRow,
  );
}

/** Parse unified `ccusage session --json` stdout (top-level key `session`, SINGULAR). */
export function parseUnifiedSession(
  stdout: string,
): ParseResult<NormalizedUnifiedSession> {
  return parseUnifiedReport(
    stdout,
    (v) => {
      const p = unifiedSessionReportSchema.safeParse(v);
      return p.success ? { rows: p.data.session, totals: p.data.totals } : null;
    },
    normalizeUnifiedSessionRow,
  );
}

/* ------------------------------------------------------------------ */
/* Unified multi-section envelope                                      */
/* ------------------------------------------------------------------ */

function normalizeAgentSlice(
  raw: unknown,
  date: string,
): RowResult<AgentDailyRow> {
  const parsed = unifiedAgentSliceSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      row: null,
      warnings: [
        warn("row-skipped", `unified agent slice skipped: ${parsed.error.message}`),
      ],
    };
  }
  const d = parsed.data;
  const warnings: NormalizeWarning[] = [];
  const classSum =
    d.inputTokens + d.outputTokens + d.cacheCreationTokens + d.cacheReadTokens;
  const totalTokens = authoritativeTotalTokens(
    raw,
    d.totalTokens,
    classSum,
    warnings,
    `unified ${d.agent} slice ${date}`,
  );
  return {
    row: {
      agent: d.agent,
      date,
      cost: d.totalCost,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheCreationTokens: d.cacheCreationTokens,
      cacheReadTokens: d.cacheReadTokens,
      totalTokens,
      modelsUsed: stripModelsUsed(d.modelsUsed),
      modelBreakdowns: mapBreakdowns(d.modelBreakdowns),
      messageCount: null,
      reasoningOutputTokens: null,
      dialect: "unified",
    },
    warnings,
  };
}

function dedupeUnknownAgentWarnings(
  warnings: NormalizeWarning[],
): NormalizeWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    if (warning.code !== "unknown-agent") return true;
    const agent = warning.context?.["agent"];
    if (typeof agent !== "string" || seen.has(agent)) return false;
    seen.add(agent);
    return true;
  });
}

/** Parse and normalize the one `--sections ... --by-agent` host envelope. */
export function parseUnifiedEnvelope(
  stdout: string,
  expectedAgents: Iterable<string> = KNOWN_HARNESS_SET,
): ParseResult<HostUsageData> {
  const json = safeParseJson(stdout);
  if (!json.ok) return { ok: false, error: json.error, warnings: [] };
  const envelope = unifiedEnvelopeSchema.safeParse(json.value);
  if (!envelope.success) {
    return {
      ok: false,
      error: `payload does not match the unified multi-section envelope: ${envelope.error.message}`,
      warnings: [],
    };
  }

  const expected = new Set([...KNOWN_HARNESS_SET, ...expectedAgents]);
  const warnings: NormalizeWarning[] = [];
  const daily: HostDailyRow[] = [];
  const monthly: MonthlyRow[] = [];
  const sessions: SessionRow[] = [];
  const agentDaily: Record<string, AgentDailyRow[]> = {};
  const agents = new Set<string>();

  for (const raw of envelope.data.daily) {
    const normalized = normalizeUnifiedDailyRow(raw);
    warnings.push(...normalized.warnings);
    if (normalized.row === null) continue;
    daily.push(normalized.row);
    for (const agent of normalized.row.agents) agents.add(agent);

    const parsedRow = unifiedDailyRowSchema.safeParse(raw);
    if (!parsedRow.success) continue;
    for (const rawSlice of parsedRow.data.agents ?? []) {
      const slice = normalizeAgentSlice(rawSlice, parsedRow.data.period);
      warnings.push(...slice.warnings);
      if (slice.row === null) continue;
      agents.add(slice.row.agent);
      (agentDaily[slice.row.agent] ??= []).push(slice.row);
      if (!expected.has(slice.row.agent)) {
        warnings.push(
          warn(
            "unknown-agent",
            `unknown harness "${slice.row.agent}" observed in daily agent slices`,
            { agent: slice.row.agent },
          ),
        );
      }
    }
  }

  for (const raw of envelope.data.monthly) {
    const normalized = normalizeUnifiedMonthlyRow(raw);
    warnings.push(...normalized.warnings);
    if (normalized.row !== null) monthly.push(normalized.row);
  }

  for (const raw of envelope.data.session) {
    const normalized = normalizeUnifiedSessionRow(raw, expected);
    warnings.push(...normalized.warnings);
    if (normalized.row !== null) {
      sessions.push(normalized.row);
      agents.add(normalized.row.agent);
    }
  }

  if (normalizeCcusageTotals(envelope.data.totals) === null) {
    warnings.push(warn("totals-missing", "report has no usable `totals` object"));
  }

  return {
    ok: true,
    value: {
      daily,
      monthly,
      sessions,
      agentDaily,
      agents: [...agents].sort(),
    },
    warnings: dedupeUnknownAgentWarnings(warnings),
  };
}
