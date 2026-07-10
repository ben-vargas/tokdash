/**
 * Display formatters — pure, deterministic, locale-pinned to en-US so the
 * SAME function produces the SAME string on server and web (G6 compares the
 * rendered KPI string to the API value formatted with these exact
 * functions). This is the ONLY layer that rounds; all upstream math is full
 * precision.
 */

import type { DateString } from "./types";

const CURRENCY_FMT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INT_FMT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

const ONE_DECIMAL_FMT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const MONTH_ABBR = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/**
 * USD with cents, en-US grouping: 5354.901 → "$5,354.90"; 0 → "$0.00";
 * negative → "-$12.34". Always exactly 2 fraction digits.
 */
export function formatCurrency(value: number): string {
  return CURRENCY_FMT.format(value);
}

/**
 * Compact token/number formatting that survives 11–14-digit counts:
 *  - |v| < 1000: plain integer ("847");
 *  - otherwise scaled to K/M/B/T with one decimal ("74.9M", "1.5B", "47.0T");
 *  - >= 1000T stays in T with en-US grouping ("46,995.7T").
 */
export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1000) return INT_FMT.format(value);
  if (abs >= 1e12) return `${ONE_DECIMAL_FMT.format(value / 1e12)}T`;
  if (abs >= 1e9) return `${ONE_DECIMAL_FMT.format(value / 1e9)}B`;
  if (abs >= 1e6) return `${ONE_DECIMAL_FMT.format(value / 1e6)}M`;
  return `${ONE_DECIMAL_FMT.format(value / 1e3)}K`;
}

/** Full integer with en-US grouping (tooltips/tables): 93028054 → "93,028,054". */
export function formatFullNumber(value: number): string {
  return INT_FMT.format(value);
}

/**
 * Relative time from `now` back to ISO timestamp `iso` (FR7 "refreshed 3m
 * ago"): <45s → "just now"; <90s → "1m ago"; then minutes/hours/days,
 * each rounded to the nearest unit. Future timestamps clamp to "just now".
 * Unparseable `iso` → "—".
 */
export function formatRelativeTime(iso: string, now: Date): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "—";
  const seconds = Math.max(0, (now.getTime() - t.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 90) return "1m ago";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(seconds / 3600);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(seconds / 86_400);
  return `${days}d ago`;
}

/**
 * FRACTION → percent string with `decimals` fraction digits (default 1):
 * formatPercent(0.4231) → "42.3%"; formatPercent(0.4231, 0) → "42%".
 */
export function formatPercent(fraction: number, decimals = 1): string {
  const fmt = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
    useGrouping: false,
  });
  return `${fmt.format(fraction * 100)}%`;
}

/**
 * KPI delta chip from KpiComparison.deltaPercent (a FRACTION or null):
 * null → "—"; 0.18 → "+18%"; -0.052 → "-5%"; 0 → "+0%".
 * Whole percent, explicit sign, ASCII hyphen-minus.
 */
export function formatDelta(deltaPercent: number | null): string {
  if (deltaPercent === null) return "—";
  const pct = Math.round(deltaPercent * 100);
  const sign = pct >= 0 ? "+" : "-";
  return `${sign}${Math.abs(pct)}%`;
}

/**
 * Short axis/tooltip label from YYYY-MM-DD, en-US month abbreviation,
 * no year: "2026-06-15" → "Jun 15". Pure string math — no timezone
 * conversion (the date is already in config tz).
 */
export function formatDateLabel(date: DateString): string {
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${MONTH_ABBR[m - 1] ?? "???"} ${d}`;
}

/** Month label from YYYY-MM: "2026-06" → "Jun 2026". */
export function formatMonthLabel(month: string): string {
  const y = month.slice(0, 4);
  const m = Number(month.slice(5, 7));
  return `${MONTH_ABBR[m - 1] ?? "???"} ${y}`;
}
