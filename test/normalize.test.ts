/** Unified envelope normalization, hostile-input handling, and row contracts. */

import { describe, expect, test } from "bun:test";
import {
  normalizeCcusageTotals,
  normalizeUnifiedDailyRow,
  normalizeUnifiedMonthlyRow,
  normalizeUnifiedSessionRow,
  parseUnifiedDaily,
  parseUnifiedEnvelope,
  parseUnifiedMonthly,
  parseUnifiedSession,
  safeParseJson,
} from "../src/shared/normalize";
import {
  hostSnapshotSchema,
  unifiedAgentSliceSchema,
  unifiedEnvelopeSchema,
} from "../src/shared/schemas";
import type { ParseResult } from "../src/shared/types";

function unwrap<T>(result: ParseResult<T>): { value: T; warnings: typeof result.warnings } {
  if (!result.ok) throw new Error(result.error);
  return result;
}

const tokens = {
  inputTokens: 10,
  outputTokens: 20,
  cacheCreationTokens: 3,
  cacheReadTokens: 4,
  totalTokens: 40,
};

function breakdown(modelName: string, cost: number) {
  return {
    modelName,
    cost,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 3,
    cacheReadTokens: 4,
  };
}

function inlineEnvelope() {
  return {
    daily: [
      {
        agent: "all",
        period: "2026-07-10",
        ...tokens,
        totalCost: 3,
        metadata: { agents: ["claude", "omp"] },
        modelsUsed: ["bare", "[omp] bare"],
        modelBreakdowns: [breakdown("bare", 1), breakdown("[omp] bare", 2)],
        agents: [
          {
            agent: "claude",
            ...tokens,
            totalCost: 1,
            modelsUsed: ["bare"],
            modelBreakdowns: [breakdown("bare", 1)],
          },
          {
            agent: "omp",
            ...tokens,
            totalCost: 2,
            modelsUsed: ["[omp] bare"],
            modelBreakdowns: [breakdown("[omp] bare", 2)],
          },
        ],
      },
    ],
    monthly: [
      {
        agent: "all",
        period: "2026-07",
        ...tokens,
        totalCost: 3,
        metadata: { agents: ["claude", "omp"] },
        modelsUsed: ["[omp] bare"],
        modelBreakdowns: [breakdown("[omp] bare", 3)],
        agents: [],
      },
    ],
    session: [
      {
        agent: "omp",
        period: "session-1",
        ...tokens,
        totalCost: 2,
        modelsUsed: ["[omp] bare"],
        modelBreakdowns: [breakdown("[omp] bare", 2)],
        metadata: null,
      },
    ],
    totals: { ...tokens, totalCost: 3 },
  };
}

describe("schemas", () => {
  test("accept the multi-section envelope and by-agent slices", () => {
    const envelope = inlineEnvelope();
    expect(unifiedEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(
      unifiedAgentSliceSchema.safeParse(envelope.daily[0]?.agents[0]).success,
    ).toBe(true);
  });

  test("cached snapshot raw shape is the one unified payload", () => {
    const data = unwrap(parseUnifiedEnvelope(JSON.stringify(inlineEnvelope()), ["omp"]));
    expect(
      hostSnapshotSchema.safeParse({
        hostId: "local",
        fetchedAt: "2026-07-10T12:00:00.000Z",
        timezone: "America/Boise",
        window: { from: "2026-04-11", to: "2026-07-10" },
        commands: [],
        raw: { unified: JSON.stringify(inlineEnvelope()) },
        data: data.value,
        warnings: data.warnings,
        error: null,
      }).success,
    ).toBe(true);
  });
});

describe("parseUnifiedEnvelope", () => {
  test("builds agentDaily from slices and strips/merges store prefixes", () => {
    const { value, warnings } = unwrap(
      parseUnifiedEnvelope(JSON.stringify(inlineEnvelope()), ["claude", "omp"]),
    );
    expect(value.daily).toHaveLength(1);
    expect(value.daily[0]?.modelBreakdowns).toEqual([
      expect.objectContaining({ modelName: "bare", cost: 3 }),
    ]);
    expect(value.monthly[0]?.modelsUsed).toEqual(["bare"]);
    expect(value.sessions[0]).toEqual(
      expect.objectContaining({
        agent: "omp",
        modelsUsed: ["bare"],
        lastActivity: null,
        projectPath: null,
      }),
    );
    expect(Object.keys(value.agentDaily).sort()).toEqual(["claude", "omp"]);
    expect(value.agentDaily["omp"]?.[0]).toEqual(
      expect.objectContaining({
        agent: "omp",
        date: "2026-07-10",
        cost: 2,
        modelsUsed: ["bare"],
        modelBreakdowns: [expect.objectContaining({ modelName: "bare", cost: 2 })],
        messageCount: null,
        reasoningOutputTokens: null,
        dialect: "unified",
      }),
    );
    expect(warnings.some((w) => w.code === "unknown-agent")).toBe(false);
  });

  test("warns once for a genuinely unknown agent across slices and sessions", () => {
    const envelope = inlineEnvelope();
    envelope.daily[0]!.metadata.agents.push("warpspeed");
    envelope.daily[0]!.agents.push({
      agent: "warpspeed",
      ...tokens,
      totalCost: 1,
      modelsUsed: [],
      modelBreakdowns: [],
    });
    envelope.session.push({
      agent: "warpspeed",
      period: "session-2",
      ...tokens,
      totalCost: 1,
      modelsUsed: [],
      modelBreakdowns: [],
      metadata: null,
    });
    const { value, warnings } = unwrap(
      parseUnifiedEnvelope(JSON.stringify(envelope), ["claude", "omp"]),
    );
    expect(value.agents).toContain("warpspeed");
    expect(
      warnings.filter(
        (w) => w.code === "unknown-agent" && w.context?.["agent"] === "warpspeed",
      ),
    ).toHaveLength(1);
  });

  test("rejects malformed JSON and incomplete envelopes", () => {
    expect(parseUnifiedEnvelope("not json").ok).toBe(false);
    expect(
      parseUnifiedEnvelope('{"daily":[],"monthly":[],"session":[]}').ok,
    ).toBe(false);
    expect(parseUnifiedEnvelope('{"daily":[]}').ok).toBe(false);
  });

  test("skips a malformed row without rejecting the envelope", () => {
    const envelope = inlineEnvelope();
    envelope.daily.push({ period: "not-a-date" } as never);
    const { value, warnings } = unwrap(
      parseUnifiedEnvelope(JSON.stringify(envelope), ["claude", "omp"]),
    );
    expect(value.daily).toHaveLength(1);
    expect(warnings.some((w) => w.code === "row-skipped")).toBe(true);
  });

  test("normalizes the full real laptop fixture", async () => {
    const text = await Bun.file(
      new URL("../fixtures/real/laptop/unified.json", import.meta.url),
    ).text();
    const { value, warnings } = unwrap(parseUnifiedEnvelope(text, ["omp"]));
    expect(value.daily).toHaveLength(85);
    expect(value.monthly).toHaveLength(4);
    expect(value.sessions).toHaveLength(3424);
    expect(Object.keys(value.agentDaily).sort()).toEqual([
      "claude",
      "codex",
      "droid",
      "omp",
      "opencode",
      "pi",
    ]);
    expect(JSON.stringify(value)).not.toContain("[omp] ");
    expect(JSON.stringify(value)).not.toContain("[pi] ");
    expect(warnings.some((w) => w.code === "unknown-agent")).toBe(false);
  });
});

describe("individual unified parsers", () => {
  test("daily preserves authoritative totalTokens and strips prefixes", () => {
    const payload = JSON.stringify({ daily: inlineEnvelope().daily, totals: {} });
    const { value } = unwrap(parseUnifiedDaily(payload));
    expect(value.rows[0]?.totalTokens).toBe(40);
    expect(value.rows[0]?.modelsUsed).toEqual(["bare"]);
  });

  test("monthly consumes metadata.agents and ignores slice details", () => {
    const payload = JSON.stringify({ monthly: inlineEnvelope().monthly, totals: {} });
    const { value } = unwrap(parseUnifiedMonthly(payload));
    expect(value.rows[0]?.month).toBe("2026-07");
    expect(value.rows[0]?.agents).toEqual(["claude", "omp"]);
  });

  test("session accepts null metadata", () => {
    const payload = JSON.stringify({ session: inlineEnvelope().session, totals: {} });
    const { value } = unwrap(parseUnifiedSession(payload));
    expect(value.rows[0]?.lastActivity).toBeNull();
  });

  test("row normalizers skip invalid periods", () => {
    expect(normalizeUnifiedDailyRow({ period: "bad" }).row).toBeNull();
    expect(normalizeUnifiedMonthlyRow({ period: "bad" }).row).toBeNull();
    expect(normalizeUnifiedSessionRow({ period: "", agent: "claude" }).row).toBeNull();
  });
});

describe("helpers", () => {
  test("safeParseJson never throws", () => {
    expect(safeParseJson("{}").ok).toBe(true);
    expect(safeParseJson("{").ok).toBe(false);
  });

  test("normalizes totals aliases and rejects unusable totals", () => {
    expect(normalizeCcusageTotals({ ...tokens, totalCost: 1.25 })?.cost).toBe(1.25);
    expect(normalizeCcusageTotals({ ...tokens, costUSD: 2.5 })?.cost).toBe(2.5);
    expect(normalizeCcusageTotals(null)).toBeNull();
  });
});
