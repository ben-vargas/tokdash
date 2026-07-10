/**
 * Timezone-aware date helpers. Pure and deterministic — no date libraries;
 * `Intl.DateTimeFormat` for tz conversion, UTC millisecond arithmetic for
 * everything else. All `DateString` values are `YYYY-MM-DD`; comparisons on
 * them are plain lexicographic (safe for this format).
 *
 * NOTHING here calls Date.now(): "now"/"today" is always injected.
 */

import { DATE_RE } from "./constants";
import type { DatePreset, DateRange, DateString, MonthString } from "./types";

const DAY_MS = 86_400_000;

/** Parse YYYY-MM-DD to UTC-midnight epoch ms (pure string math, no tz). */
function utcMs(date: DateString): number {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return Date.UTC(y, m - 1, d);
}

/** Format a UTC epoch ms back to YYYY-MM-DD. */
function fromUtcMs(ms: number): DateString {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The calendar date of instant `now` in IANA timezone `tz`, as YYYY-MM-DD.
 * Throws TypeError/RangeError only for an invalid tz — validate first with
 * isValidTimezone when the tz comes from config.
 */
export function todayInTz(tz: string, now: Date): DateString {
  // en-CA formats dates as YYYY-MM-DD.
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(now);
}

/** True iff `s` matches YYYY-MM-DD AND is a real calendar date (rejects 2026-02-30). */
export function isValidDateString(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12) return false;
  if (d < 1) return false;
  // Day 0 of the NEXT month is the last day of month m.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last;
}

/** True iff `tz` is an IANA timezone Intl can resolve. Never throws. */
export function isValidTimezone(tz: string): boolean {
  if (tz === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `date` shifted by `days` (may be negative). addDays("2026-03-01", -1) === "2026-02-28". */
export function addDays(date: DateString, days: number): DateString {
  return fromUtcMs(utcMs(date) + days * DAY_MS);
}

/**
 * Whole days from `from` to `to` (to − from): diffDays("2026-06-01","2026-06-30") === 29.
 * Negative when `to` precedes `from`.
 */
export function diffDays(from: DateString, to: DateString): number {
  return Math.round((utcMs(to) - utcMs(from)) / DAY_MS);
}

/** Lexicographic compare: <0 if a<b, 0 if equal, >0 if a>b. */
export function compareDates(a: DateString, b: DateString): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The earlier of two dates. */
export function minDate(a: DateString, b: DateString): DateString {
  return a <= b ? a : b;
}

/** The later of two dates. */
export function maxDate(a: DateString, b: DateString): DateString {
  return a >= b ? a : b;
}

/**
 * Every date from `from` through `to` INCLUSIVE, ascending. Length is
 * diffDays(from,to)+1. Returns [] when from > to. This is the zero-fill
 * backbone.
 */
export function dateRangeInclusive(
  from: DateString,
  to: DateString,
): DateString[] {
  const out: DateString[] = [];
  const start = utcMs(from);
  const n = diffDays(from, to);
  for (let i = 0; i <= n; i++) out.push(fromUtcMs(start + i * DAY_MS));
  return out;
}

/**
 * The immediately preceding period of EQUAL length (FR2 comparison basis).
 * For {from,to} of length N days: { from: addDays(from, -N), to: addDays(from, -1) }.
 */
export function previousPeriod(range: DateRange): DateRange {
  const n = diffDays(range.from, range.to) + 1;
  return { from: addDays(range.from, -n), to: addDays(range.from, -1) };
}

/**
 * Resolve an FR1 preset to an inclusive range ending `today`:
 *  - "today"          => { from: today, to: today }
 *  - "Nd" (7d..90d)   => { from: addDays(today, -(N-1)), to: today }
 *  - "mtd"            => { from: startOfMonth(today), to: today }
 */
export function resolvePreset(preset: DatePreset, today: DateString): DateRange {
  if (preset === "today") return { from: today, to: today };
  if (preset === "mtd") return monthToDateRange(today);
  const n = Number.parseInt(preset, 10);
  return { from: addDays(today, -(n - 1)), to: today };
}

/** "2026-06-15" => "2026-06". */
export function monthOf(date: DateString): MonthString {
  return date.slice(0, 7);
}

/** Number of days in a YYYY-MM month (leap-aware): daysInMonth("2028-02") === 29. */
export function daysInMonth(month: MonthString): number {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 1-based day of month: dayOfMonth("2026-06-15") === 15. */
export function dayOfMonth(date: DateString): number {
  return Number(date.slice(8, 10));
}

/** "2026-06-15" => "2026-06-01". */
export function startOfMonth(date: DateString): DateString {
  return `${monthOf(date)}-01`;
}

/** "2026-06-15" => "2026-06-30". */
export function endOfMonth(date: DateString): DateString {
  const month = monthOf(date);
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

/** Month-to-date range: { from: startOfMonth(today), to: today }. */
export function monthToDateRange(today: DateString): DateRange {
  return { from: startOfMonth(today), to: today };
}

/**
 * Calendar date (YYYY-MM-DD) of ISO timestamp `iso` in timezone `tz`.
 * Returns null when `iso` is unparseable (hostile input). Never throws.
 */
export function isoToDateInTz(iso: string, tz: string): DateString | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  try {
    return todayInTz(tz, t);
  } catch {
    return null;
  }
}
