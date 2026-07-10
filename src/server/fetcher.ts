/**
 * Per-host refresh (PROMPT.md §3.2): one unified ccusage invocation returns
 * daily, monthly, session, and per-agent daily slices in one JSON envelope.
 *
 * Degradation rules:
 *   - any execution failure degrades the host to its previous snapshot;
 *   - malformed JSON or an invalid multi-section envelope does the same;
 *   - individual malformed rows are skipped with normalization warnings.
 */

import { KNOWN_HARNESS_SET } from "../shared/constants";
import { parseUnifiedEnvelope, safeParseJson } from "../shared/normalize";
import { emptyHostUsageData } from "../shared/merge";
import type {
  CommandRecord,
  DateRange,
  HostConfig,
  HostError,
  HostSnapshot,
} from "../shared/types";
import {
  buildUnifiedFetchCommand,
  extractJsonPayload,
  UNIFIED_TIMEOUT_MS,
} from "./command";
import type { CcusageArgOptions } from "./command";
import type { CommandExecutor, ExecResult } from "./executor";

export interface FetchHostOptions {
  timezone: string;
  /** Inclusive fetch window (from = today − fetchWindowDays, to = today). */
  window: DateRange;
  executor: CommandExecutor;
  now: () => Date;
  /** Last known snapshot — preserved verbatim on host-level failure. */
  previous: HostSnapshot | null;
}

/** Last ~500 chars of stderr, for diagnostics without megabyte blobs. */
export function stderrTail(stderr: string, limit = 500): string {
  const trimmed = stderr.trimEnd();
  return trimmed.length <= limit ? trimmed : trimmed.slice(-limit);
}

/** Interpret an ExecResult as a host-level failure, or null when usable. */
export function classifyHostFailure(
  res: ExecResult,
  at: string,
): HostError | null {
  if (res.timedOut) {
    return {
      kind: "timeout",
      message: `command timed out after ${Math.round(res.durationMs)}ms`,
      exitCode: null,
      stderrTail: stderrTail(res.stderr),
      at,
    };
  }
  if (res.exitCode === 0) return null;
  if (res.exitCode === 255) {
    return {
      kind: "unreachable",
      message: "ssh-level failure (exit 255) — host unreachable or auth failed",
      exitCode: 255,
      stderrTail: stderrTail(res.stderr),
      at,
    };
  }
  if (res.exitCode === 127) {
    return {
      kind: "exit",
      message: "command not found (exit 127) — check ccusageCmd PATH handling",
      exitCode: 127,
      stderrTail: stderrTail(res.stderr),
      at,
    };
  }
  if (res.exitCode === null) {
    return {
      kind: "unknown",
      message: "process produced no exit code",
      exitCode: null,
      stderrTail: stderrTail(res.stderr),
      at,
    };
  }
  return {
    kind: "exit",
    message: `command exited with code ${res.exitCode}${res.exitCode === 2 ? " (ccusage argument error)" : ""}`,
    exitCode: res.exitCode,
    stderrTail: stderrTail(res.stderr),
    at,
  };
}

function record(argv: string[], res: ExecResult): CommandRecord {
  return {
    name: "unified",
    argv,
    exitCode: res.exitCode,
    durationMs: Math.round(res.durationMs),
    bytes: Buffer.byteLength(res.stdout, "utf8"),
    stderrTail: stderrTail(res.stderr),
    timedOut: res.timedOut,
  };
}

/** Preserve the last good data/raw/fetchedAt on any host-level failure. */
function degradedSnapshot(
  host: HostConfig,
  opts: FetchHostOptions,
  commands: CommandRecord[],
  error: HostError,
): HostSnapshot {
  if (opts.previous !== null) {
    return { ...opts.previous, commands, error };
  }
  return {
    hostId: host.id,
    fetchedAt: opts.now().toISOString(),
    timezone: opts.timezone,
    window: opts.window,
    commands,
    raw: { unified: null },
    data: emptyHostUsageData(),
    warnings: [],
    error,
  };
}

/** One full per-host refresh. Never throws; failures land in snapshot.error. */
export async function fetchHostSnapshot(
  host: HostConfig,
  opts: FetchHostOptions,
): Promise<HostSnapshot> {
  const argOpts: CcusageArgOptions = {
    since: opts.window.from,
    until: opts.window.to,
    timezone: opts.timezone,
  };
  const built = buildUnifiedFetchCommand(host, argOpts);
  const res = await opts.executor.run({
    hostId: host.id,
    ssh: host.ssh,
    command: built.command,
    timeoutMs: UNIFIED_TIMEOUT_MS,
  });
  const commands = [record(built.argv, res)];
  const at = opts.now().toISOString();

  const executionFailure = classifyHostFailure(res, at);
  if (executionFailure !== null) {
    return degradedSnapshot(host, opts, commands, executionFailure);
  }

  const unified = extractJsonPayload(res.stdout);
  const expectedAgents = new Set(KNOWN_HARNESS_SET);
  for (const source of host.extraSources ?? []) expectedAgents.add(source.agent);
  const normalized = parseUnifiedEnvelope(unified, expectedAgents);
  if (!normalized.ok) {
    const jsonWasValid = safeParseJson(unified).ok;
    return degradedSnapshot(host, opts, commands, {
      kind: jsonWasValid ? "schema" : "bad-json",
      message: `unified stdout did not parse: ${normalized.error}`,
      exitCode: res.exitCode,
      stderrTail: stderrTail(res.stderr),
      at,
    });
  }

  return {
    hostId: host.id,
    fetchedAt: at,
    timezone: opts.timezone,
    window: opts.window,
    commands,
    raw: { unified },
    data: normalized.value,
    warnings: normalized.warnings,
    error: null,
  };
}
