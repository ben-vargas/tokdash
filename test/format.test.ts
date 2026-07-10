/**
 * Tests for the display-formatting layer — src/shared/format.ts.
 *
 * These formatters are the ONLY rounding layer in TokDash and MUST be
 * deterministic and locale-pinned to en-US: G6 string-compares the rendered
 * KPI text against the API's full-precision number formatted with these exact
 * functions, so server === web. Every assertion below is a behavioral contract
 * from PROMPT.md §4 (FR2/FR7) and the frozen stub docs in format.ts.
 *
 * TDD RED PHASE: src/shared/format.ts is a stub whose bodies all
 * `throw new Error("not implemented")`. Every test here is expected to FAIL
 * right now, but the file MUST type-check under `bunx tsc --noEmit`.
 *
 * INDEPENDENT DERIVATION RULE: no expected value below was obtained by running
 * the function under test. Currency/number expectations were derived from
 * `Intl.NumberFormat("en-US", …)` computed OUT OF BAND (see the bun -e session
 * in the authoring notes) — that is the reference the formatter must match, not
 * the formatter's own output. Token/relative-time/date expectations are
 * hand-constructed from the contract with obvious closed-form answers. Fixture
 * magnitudes (huge-cache-read.json, real/local/unified.json totals) are pulled in
 * verbatim to prove the formatter survives 11–14-digit token counts and messy
 * unrounded float costs.
 *
 * From test/ (repo root) the shared modules live at ../src/shared/*.
 */

import { describe, expect, test } from "bun:test";

import {
  formatCurrency,
  formatTokens,
  formatFullNumber,
  formatRelativeTime,
  formatPercent,
  formatDelta,
  formatDateLabel,
  formatMonthLabel,
} from "../src/shared/format";
import type { DateString } from "../src/shared/types";

/* ------------------------------------------------------------------ */
/* Fixture-derived magnitudes (read verbatim; NOT via code under test)  */
/* ------------------------------------------------------------------ */

// fixtures/synthetic/huge-cache-read.json — proves the compact token formatter
// and the currency formatter survive the largest real-shaped values.
//   row 0: totalCost = 82.06393750000001, totalTokens = 82_066_994_312
//   row 1: totalCost = 39.6598589700001,  totalTokens = 47_444_023_389_871
// fixtures/real/local/unified.json → .totals:
//   totalCost = 9204.628823847195, totalTokens = 7_610_185_001
const HUGE_ROW0_COST = 82.06393750000001;
const HUGE_ROW0_TOTAL_TOKENS = 82_066_994_312; // 82.066…B
const HUGE_ROW1_COST = 39.6598589700001;
const HUGE_ROW1_TOTAL_TOKENS = 47_444_023_389_871; // 47.444…T
const LOCAL_TOTALS_COST = 9204.628823847195;
const LOCAL_TOTALS_TOTAL_TOKENS = 7_610_185_001; // 7.610…B

// Sanity: the synthetic huge-cache-read fixture on disk still carries the exact
// magnitudes the assertions below are pinned to. If Phase-0 fixtures drift, this
// guards the whole file rather than letting stale constants pass silently.
test("huge-cache-read fixture still carries the pinned magnitudes", async () => {
  const raw = (await Bun.file(
    new URL("../fixtures/synthetic/huge-cache-read.json", import.meta.url),
  ).json()) as {
    daily: Array<{ totalCost: number; totalTokens: number }>;
  };
  expect(raw.daily[0]?.totalCost).toBe(HUGE_ROW0_COST);
  expect(raw.daily[0]?.totalTokens).toBe(HUGE_ROW0_TOTAL_TOKENS);
  expect(raw.daily[1]?.totalCost).toBe(HUGE_ROW1_COST);
  expect(raw.daily[1]?.totalTokens).toBe(HUGE_ROW1_TOTAL_TOKENS);
});

test("real/local/unified.json totals still carry the pinned magnitudes", async () => {
  const raw = (await Bun.file(
    new URL("../fixtures/real/local/unified.json", import.meta.url),
  ).json()) as { totals: { totalCost: number; totalTokens: number } };
  expect(raw.totals.totalCost).toBe(LOCAL_TOTALS_COST);
  expect(raw.totals.totalTokens).toBe(LOCAL_TOTALS_TOTAL_TOKENS);
});

/* ------------------------------------------------------------------ */
/* formatCurrency                                                       */
/* ------------------------------------------------------------------ */

describe("formatCurrency", () => {
  // Reference values computed independently with:
  //   new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",
  //     minimumFractionDigits:2,maximumFractionDigits:2})
  // (run out of band; results transcribed here, NOT read back from format.ts).

  test("basic value: cents + thousands separator", () => {
    // June anchor magnitude from the facts block.
    expect(formatCurrency(5354.901)).toBe("$5,354.90");
  });

  test("zero renders exactly two fraction digits", () => {
    expect(formatCurrency(0)).toBe("$0.00");
  });

  test("negative uses a leading minus before the dollar sign", () => {
    expect(formatCurrency(-12.34)).toBe("-$12.34");
  });

  test("rounds only at display time — long unrounded float from ccusage", () => {
    // huge-cache-read row 0: 82.06393750000001 → cents .06 (…639 rounds DOWN).
    // Costs aggregate in full precision upstream; this is the sole rounding point.
    expect(formatCurrency(HUGE_ROW0_COST)).toBe("$82.06");
  });

  test("rounds a large messy float up with grouping", () => {
    // real/local/unified.json totals.totalCost = 9204.628823847195.
    expect(formatCurrency(LOCAL_TOTALS_COST)).toBe("$9,204.63");
  });

  test("another real unrounded float rounds down and groups thousands", () => {
    // A real per-day max from local/unified.json.
    expect(formatCurrency(851.5644541499985)).toBe("$851.56");
  });

  test("half-cent rounds up (round-half-up per Intl) — documented in stub", () => {
    expect(formatCurrency(0.005)).toBe("$0.01");
  });

  test("grouping carry across the thousands boundary", () => {
    // 999.995 rounds to 1000.00 and must gain a thousands separator.
    expect(formatCurrency(999.995)).toBe("$1,000.00");
  });

  test("million-scale value groups every three digits", () => {
    expect(formatCurrency(1234567.891)).toBe("$1,234,567.89");
  });

  test("is pure — same input yields the same string across calls", () => {
    expect(formatCurrency(HUGE_ROW1_COST)).toBe(formatCurrency(HUGE_ROW1_COST));
  });
});

/* ------------------------------------------------------------------ */
/* formatTokens                                                         */
/* ------------------------------------------------------------------ */

describe("formatTokens", () => {
  // Contract (stub doc):
  //   |v| < 1000        → plain integer, no unit ("847")
  //   >= 1000           → K/M/B/T with ONE decimal ("74.9M","1.5B","47.0T")
  //   >= 1000T (>=1e15) → stays in T with en-US grouping ("46,995.7T")
  //   negatives keep the leading "-"; half-up at the shown precision.

  test("values below 1000 render as a plain integer with no unit", () => {
    expect(formatTokens(847)).toBe("847");
  });

  test("zero renders as plain '0'", () => {
    expect(formatTokens(0)).toBe("0");
  });

  test("999 stays plain (still below the 1000 threshold)", () => {
    expect(formatTokens(999)).toBe("999");
  });

  test("exactly 1000 scales into K with one decimal", () => {
    // 1000 / 1e3 = 1.0 → "1.0K".
    expect(formatTokens(1000)).toBe("1.0K");
  });

  test("thousands scale to K with one decimal", () => {
    // 74_850 / 1e3 = 74.85 → half-up at one decimal → "74.9K".
    expect(formatTokens(74_850)).toBe("74.9K");
  });

  test("millions scale to M with one decimal (stub example 74.9M)", () => {
    // 74_900_000 / 1e6 = 74.9 → "74.9M".
    expect(formatTokens(74_900_000)).toBe("74.9M");
  });

  test("billions scale to B with one decimal (stub example 1.5B)", () => {
    // 1_500_000_000 / 1e9 = 1.5 → "1.5B".
    expect(formatTokens(1_500_000_000)).toBe("1.5B");
  });

  test("real ~7.61B total-token count scales to B", () => {
    expect(formatTokens(LOCAL_TOTALS_TOTAL_TOKENS)).toBe("7.6B");
  });

  test("huge-cache-read row 0 total tokens scale to B", () => {
    // 82_066_994_312 / 1e9 = 82.066… → "82.1B".
    expect(formatTokens(HUGE_ROW0_TOTAL_TOKENS)).toBe("82.1B");
  });

  test("trillions scale to T with one decimal (stub example 47.0T)", () => {
    // 47_000_000_000_000 / 1e12 = 47.0 → "47.0T".
    expect(formatTokens(47_000_000_000_000)).toBe("47.0T");
  });

  test("huge-cache-read row 1 total tokens scale to T", () => {
    // 47_444_023_389_871 / 1e12 = 47.444… → half-up one decimal → "47.4T".
    expect(formatTokens(HUGE_ROW1_TOTAL_TOKENS)).toBe("47.4T");
  });

  test("values >= 1000 trillion stay in T with grouping (stub example)", () => {
    // 46_995_700_000_000_000 / 1e12 = 46_995.7 → grouped → "46,995.7T".
    expect(formatTokens(46_995_700_000_000_000)).toBe("46,995.7T");
  });

  test("negative token counts keep the leading minus", () => {
    // Deltas can go negative; -74.9M must retain its sign and unit.
    expect(formatTokens(-74_900_000)).toBe("-74.9M");
  });

  test("negative small value stays plain with sign", () => {
    expect(formatTokens(-847)).toBe("-847");
  });

  test("is pure — same input yields the same string across calls", () => {
    expect(formatTokens(HUGE_ROW1_TOTAL_TOKENS)).toBe(
      formatTokens(HUGE_ROW1_TOTAL_TOKENS),
    );
  });
});

/* ------------------------------------------------------------------ */
/* formatFullNumber                                                     */
/* ------------------------------------------------------------------ */

describe("formatFullNumber", () => {
  // Reference: new Intl.NumberFormat("en-US",{maximumFractionDigits:0}).

  test("groups every three digits (stub example)", () => {
    expect(formatFullNumber(93028054)).toBe("93,028,054");
  });

  test("small integers are unchanged (no separator)", () => {
    expect(formatFullNumber(42)).toBe("42");
  });

  test("zero is '0'", () => {
    expect(formatFullNumber(0)).toBe("0");
  });

  test("real ~7.61B total-token count keeps full precision with grouping", () => {
    // Unlike formatTokens, full-number NEVER abbreviates — tooltips/tables show
    // every digit: 7_132_116_681 → "7,132,116,681".
    expect(formatFullNumber(LOCAL_TOTALS_TOTAL_TOKENS)).toBe("7,610,185,001");
  });

  test("14-digit token count keeps every digit", () => {
    // huge-cache-read row 1: 47_444_023_389_871 → grouped, unabbreviated.
    expect(formatFullNumber(HUGE_ROW1_TOTAL_TOKENS)).toBe("47,444,023,389,871");
  });

  test("negative integers keep the sign and grouping", () => {
    expect(formatFullNumber(-93028054)).toBe("-93,028,054");
  });
});

/* ------------------------------------------------------------------ */
/* formatRelativeTime                                                   */
/* ------------------------------------------------------------------ */

describe("formatRelativeTime", () => {
  // Contract (stub doc + FR7 "refreshed 3m ago"): distance from `now` back to
  // ISO `iso`. `now` is INJECTED (never Date.now()) so the function is pure.
  //   < 45s  → "just now"
  //   < 90s  → "1m ago"
  //   else minutes / hours / days, each rounded to the NEAREST unit
  //   future timestamps clamp to "just now"
  //   unparseable iso → "—"
  // Fixed anchor keeps everything deterministic:
  const NOW = new Date("2026-07-02T12:00:00.000Z");

  /** `secondsAgo` before NOW, as an ISO string. */
  function ago(seconds: number): string {
    return new Date(NOW.getTime() - seconds * 1000).toISOString();
  }

  test("under 45s reads 'just now'", () => {
    expect(formatRelativeTime(ago(30), NOW)).toBe("just now");
  });

  test("exactly now reads 'just now'", () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("just now");
  });

  test("between 45s and 90s reads '1m ago'", () => {
    // 60s and 89s both fall in the [45,90) band → "1m ago".
    expect(formatRelativeTime(ago(60), NOW)).toBe("1m ago");
    expect(formatRelativeTime(ago(89), NOW)).toBe("1m ago");
  });

  test("a few minutes reads 'Nm ago' (FR7 example)", () => {
    // 180s = exactly 3 minutes → "3m ago".
    expect(formatRelativeTime(ago(180), NOW)).toBe("3m ago");
  });

  test("exact hour reads 'Nh ago'", () => {
    // 7200s = exactly 2h → "2h ago".
    expect(formatRelativeTime(ago(2 * 3600), NOW)).toBe("2h ago");
  });

  test("exact day count reads 'Nd ago'", () => {
    // 5 * 86400s = exactly 5 days → "5d ago".
    expect(formatRelativeTime(ago(5 * 86400), NOW)).toBe("5d ago");
  });

  test("just under an hour still rounds to minutes, not 1h", () => {
    // 59 minutes exactly is unambiguously "59m ago" (nearest unit is minutes).
    expect(formatRelativeTime(ago(59 * 60), NOW)).toBe("59m ago");
  });

  test("future timestamp clamps to 'just now'", () => {
    // iso AFTER now (e.g. clock skew across hosts) must never read "-5m ago".
    const future = new Date(NOW.getTime() + 5 * 60_000).toISOString();
    expect(formatRelativeTime(future, NOW)).toBe("just now");
  });

  test("unparseable iso renders the em-dash placeholder", () => {
    expect(formatRelativeTime("not-a-date", NOW)).toBe("—");
    expect(formatRelativeTime("", NOW)).toBe("—");
  });

  test("is pure — injected now, same inputs yield same output", () => {
    const iso = ago(3 * 3600);
    expect(formatRelativeTime(iso, NOW)).toBe(formatRelativeTime(iso, NOW));
  });
});

/* ------------------------------------------------------------------ */
/* formatPercent                                                        */
/* ------------------------------------------------------------------ */

describe("formatPercent", () => {
  // Contract: FRACTION input → percent string; default 1 fraction digit.

  test("default one decimal (stub example 0.4231 → 42.3%)", () => {
    // 0.4231 * 100 = 42.31 → half-up at one decimal → "42.3%".
    expect(formatPercent(0.4231)).toBe("42.3%");
  });

  test("1 → '100.0%'", () => {
    expect(formatPercent(1)).toBe("100.0%");
  });

  test("zero fraction → '0.0%'", () => {
    expect(formatPercent(0)).toBe("0.0%");
  });

  test("decimals override to 0 (stub example 0.4231,0 → 42%)", () => {
    // 42.31 → half-up at zero decimals → "42%".
    expect(formatPercent(0.4231, 0)).toBe("42%");
  });

  test("share fraction well under 1% with two decimals", () => {
    // BreakdownRow.share can be tiny; 0.00123 * 100 = 0.123 → 2dp → "0.12%".
    expect(formatPercent(0.00123, 2)).toBe("0.12%");
  });

  test("is pure — same input yields same string", () => {
    expect(formatPercent(0.4231)).toBe(formatPercent(0.4231));
  });
});

/* ------------------------------------------------------------------ */
/* formatDelta                                                          */
/* ------------------------------------------------------------------ */

describe("formatDelta", () => {
  // Contract: KpiComparison.deltaPercent is a FRACTION or null.
  //   null → "—" (prior period not covered / previous value 0)
  //   whole-percent output, explicit sign, ASCII hyphen-minus for negatives.

  test("null renders the em-dash placeholder (FR2 uncovered prior period)", () => {
    expect(formatDelta(null)).toBe("—");
  });

  test("positive fraction gets a '+' sign and whole percent (stub example)", () => {
    // 0.18 → +18% (the "+18% vs prior 30d" chip from FR2).
    expect(formatDelta(0.18)).toBe("+18%");
  });

  test("negative fraction rounds to whole percent with ASCII hyphen (stub example)", () => {
    // -0.052 → -5% (rounded to whole percent; hyphen-minus, not U+2212).
    expect(formatDelta(-0.052)).toBe("-5%");
  });

  test("zero renders '+0%' (explicit plus sign)", () => {
    expect(formatDelta(0)).toBe("+0%");
  });

  test("uses an ASCII hyphen-minus, not a Unicode minus", () => {
    const s = formatDelta(-0.052);
    // U+002D present, U+2212 absent.
    expect(s.includes("-")).toBe(true);
    expect(s.includes("−")).toBe(false);
  });

  test("rounds a large fraction to whole percent", () => {
    // 1.239 → +124% (half-up whole percent).
    expect(formatDelta(1.239)).toBe("+124%");
  });

  test("is pure — same input yields same string", () => {
    expect(formatDelta(0.18)).toBe(formatDelta(0.18));
  });
});

/* ------------------------------------------------------------------ */
/* formatDateLabel                                                      */
/* ------------------------------------------------------------------ */

describe("formatDateLabel", () => {
  // Contract: YYYY-MM-DD → "Mon DD", en-US month abbreviation, NO year.
  // Pure string math — NO timezone conversion (the date is already in config tz,
  // so a naive `new Date("2026-06-15")` parsed as UTC-midnight must never shift
  // the label by a day for viewers west of UTC).

  const JUN_15: DateString = "2026-06-15";

  test("mid-month date (stub example Jun 15)", () => {
    expect(formatDateLabel(JUN_15)).toBe("Jun 15");
  });

  test("first of the month keeps the day number without a leading zero", () => {
    expect(formatDateLabel("2026-01-01")).toBe("Jan 1");
  });

  test("December maps to 'Dec'", () => {
    expect(formatDateLabel("2026-12-31")).toBe("Dec 31");
  });

  test("no timezone drift — a UTC-midnight parse would wrongly show Jun 14", () => {
    // This is the whole reason the doc mandates pure string math: assert the day
    // component is preserved exactly regardless of the host's local timezone.
    expect(formatDateLabel(JUN_15)).toBe("Jun 15");
    expect(formatDateLabel(JUN_15)).not.toBe("Jun 14");
  });

  test("does not include a year", () => {
    expect(formatDateLabel(JUN_15)).not.toContain("2026");
  });

  test("is pure — same input yields same string", () => {
    expect(formatDateLabel(JUN_15)).toBe(formatDateLabel(JUN_15));
  });
});

/* ------------------------------------------------------------------ */
/* formatMonthLabel                                                     */
/* ------------------------------------------------------------------ */

describe("formatMonthLabel", () => {
  // Contract: YYYY-MM → "Mon YYYY" (stub example "2026-06" → "Jun 2026").

  test("mid-year month (stub example Jun 2026)", () => {
    expect(formatMonthLabel("2026-06")).toBe("Jun 2026");
  });

  test("January", () => {
    expect(formatMonthLabel("2026-01")).toBe("Jan 2026");
  });

  test("December", () => {
    expect(formatMonthLabel("2025-12")).toBe("Dec 2025");
  });

  test("includes the four-digit year", () => {
    expect(formatMonthLabel("2026-06")).toContain("2026");
  });

  test("is pure — same input yields same string", () => {
    expect(formatMonthLabel("2026-06")).toBe(formatMonthLabel("2026-06"));
  });
});
