/**
 * Safe ccusage command construction (PROMPT.md §3.1).
 *
 * `ccusageCmd` from config is a TRUSTED shell prefix. Dates, timezone, and
 * extra-source config appended to it are validated and/or shell-quoted here.
 */

import { DATE_RE, TZ_RE } from "../shared/constants";
import type { HostConfig } from "../shared/types";

/** One unified report now replaces every former per-section invocation. */
export const UNIFIED_TIMEOUT_MS = 180_000;

/** Thrown whenever an input fails command-construction validation. */
export class CommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandValidationError";
  }
}

/** Optional windowing flags appended to a report invocation. */
export interface CcusageArgOptions {
  /** Inclusive start date, YYYY-MM-DD. */
  since?: string;
  /** Inclusive end date, YYYY-MM-DD. */
  until?: string;
  /** IANA timezone passed as -z so day boundaries agree across hosts. */
  timezone?: string;
}

/** A fully built invocation: shell string + logical argv (for CommandRecord). */
export interface BuiltCommand {
  command: string;
  argv: string[];
}

function assertDate(value: string, label: string): string {
  if (typeof value !== "string" || !DATE_RE.test(value)) {
    throw new CommandValidationError(
      `${label} must be YYYY-MM-DD, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function assertTimezone(tz: string): string {
  if (typeof tz !== "string" || !TZ_RE.test(tz)) {
    throw new CommandValidationError(
      `timezone contains disallowed characters: ${JSON.stringify(tz)}`,
    );
  }
  return tz;
}

/** Validated flag tail shared by report invocations: --json -s -u -z. */
function argTail(opts: CcusageArgOptions): string[] {
  const tail: string[] = ["--json"];
  if (opts.since !== undefined) tail.push("-s", assertDate(opts.since, "since"));
  if (opts.until !== undefined) tail.push("-u", assertDate(opts.until, "until"));
  if (opts.timezone !== undefined) tail.push("-z", assertTimezone(opts.timezone));
  return tail;
}

function assertShellArg(value: string): string {
  if (typeof value !== "string" || value.length === 0 || /[\x00-\x1F\x7F]/u.test(value)) {
    throw new CommandValidationError(
      `shell argument is empty or contains control characters: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** POSIX single-quote escaping for config JSON and any future shell argument. */
function shellQuoteArg(value: string): string {
  return `'${assertShellArg(value).replaceAll("'", "'\\''")}'`;
}

/**
 * Build the one ccusage invocation used for a complete host refresh.
 * Extra pi-format stores are declared in a temporary ccusage config file.
 */
export function buildUnifiedFetchCommand(
  host: HostConfig,
  opts: CcusageArgOptions,
): BuiltCommand {
  const tail = argTail(opts);
  // Keep the verified command ordering: sections/by-agent before the window.
  const ordered = [
    "daily",
    "--json",
    "--sections",
    "daily,monthly,session",
    "--by-agent",
    ...tail.slice(1),
  ];
  const base = `${host.ccusageCmd} ${ordered.join(" ")}`;
  const argv = ["ccusage", ...ordered];
  const stores = (host.extraSources ?? []).map(({ agent, path }) => ({
    name: agent,
    path,
  }));
  if (stores.length === 0) return { command: base, argv };

  const config = JSON.stringify({ pi: { stores } });
  return {
    command:
      `CFG=$(mktemp); trap 'rm -f "$CFG"' EXIT; ` +
      `printf '%s' ${shellQuoteArg(config)} > "$CFG"; ${base} --config "$CFG"`,
    argv: [...argv, "--config", "<tempfile>"],
  };
}

/** `<prefix> --version` — the cheap test-connection probe. */
export function buildVersionCommand(ccusageCmd: string): BuiltCommand {
  return { command: `${ccusageCmd} --version`, argv: ["ccusage", "--version"] };
}

/**
 * Best-effort extraction of a JSON payload, tolerating bunx/npm chatter that
 * leaks onto stdout on some hosts.
 */
export function extractJsonPayload(text: string): string {
  const trimmed = text.trim();
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  let start = -1;
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);
  if (start === -1) return trimmed;
  const lastObj = trimmed.lastIndexOf("}");
  const lastArr = trimmed.lastIndexOf("]");
  const end = Math.max(lastObj, lastArr);
  if (end < start) return trimmed;
  return trimmed.slice(start, end + 1);
}
