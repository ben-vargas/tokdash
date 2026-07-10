/**
 * Command execution abstraction: one interface, three implementations.
 *
 *   - LocalExecutor  — `sh -c <command>` via Bun.spawn (ssh: null hosts)
 *   - SshExecutor    — `ssh -o BatchMode=yes -o ConnectTimeout=10 <alias> '<command>'`
 *   - MockExecutor   — MOCK=1: replays fixtures/real/<hostId>/ with ~zero latency
 *
 * plus SystemExecutor, which routes per-request to Local or Ssh based on the
 * host's `ssh` field. stdout and stderr are ALWAYS captured separately
 * (merging streams breaks JSON.parse — §2.1); processes are killed on
 * timeout and a timeout is reported, never thrown.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ExecRequest {
  /** Config host id — used by MockExecutor to select the fixture directory. */
  hostId: string;
  /** SSH alias from config; null = run locally. */
  ssh: string | null;
  /** Full shell command line (trusted prefix + validated args). */
  command: string;
  /** Kill the process after this many ms. */
  timeoutMs: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed (timeout) or never produced a code. */
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface CommandExecutor {
  run(req: ExecRequest): Promise<ExecResult>;
}

/* ------------------------------------------------------------------ */
/* Process runner shared by Local + Ssh                                */
/* ------------------------------------------------------------------ */

async function runArgv(argv: string[], timeoutMs: number): Promise<ExecResult> {
  const started = performance.now();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch (err) {
    return {
      stdout: "",
      stderr: `failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
      exitCode: null,
      durationMs: performance.now() - started,
      timedOut: false,
    };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited.catch(() => null),
  ]);
  clearTimeout(timer);
  const exitCode = timedOut ? null : proc.exitCode;
  return {
    stdout,
    stderr,
    exitCode,
    durationMs: performance.now() - started,
    timedOut,
  };
}

/** Runs the command locally through `sh -c`. */
export class LocalExecutor implements CommandExecutor {
  run(req: ExecRequest): Promise<ExecResult> {
    return runArgv(["sh", "-c", req.command], req.timeoutMs);
  }
}

/** The exact ssh argv used for a remote invocation (exported for tests). */
export function sshArgv(alias: string, command: string): string[] {
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    alias,
    command,
  ];
}

/** Runs the command on a remote host via its ~/.ssh/config alias. */
export class SshExecutor implements CommandExecutor {
  async run(req: ExecRequest): Promise<ExecResult> {
    if (req.ssh === null) {
      return {
        stdout: "",
        stderr: `SshExecutor requires an ssh alias for host ${req.hostId}`,
        exitCode: null,
        durationMs: 0,
        timedOut: false,
      };
    }
    return runArgv(sshArgv(req.ssh, req.command), req.timeoutMs);
  }
}

/** Routes each request to LocalExecutor (ssh: null) or SshExecutor. */
export class SystemExecutor implements CommandExecutor {
  private readonly local = new LocalExecutor();
  private readonly remote = new SshExecutor();

  run(req: ExecRequest): Promise<ExecResult> {
    return req.ssh === null ? this.local.run(req) : this.remote.run(req);
  }
}

/* ------------------------------------------------------------------ */
/* MockExecutor — fixture replay for MOCK=1, tests, and UI dev         */
/* ------------------------------------------------------------------ */

/** fixtures/real relative to this file (src/server → repo root → fixtures). */
export const DEFAULT_FIXTURES_ROOT = join(
  import.meta.dir,
  "..",
  "..",
  "fixtures",
  "real",
);

export const MOCK_CCUSAGE_VERSION = "20.0.16";

/**
 * Replays fixtures/real/<hostId>/unified.json for any command containing the
 * unified `--sections` flag, including the temporary-config wrapper script.
 * `--version` returns a canned version. Everything else is rejected.
 */
export class MockExecutor implements CommandExecutor {
  constructor(private readonly fixturesRoot: string = DEFAULT_FIXTURES_ROOT) {}

  async run(req: ExecRequest): Promise<ExecResult> {
    const started = performance.now();
    const done = (partial: Omit<ExecResult, "durationMs">): ExecResult => ({
      ...partial,
      durationMs: performance.now() - started,
    });

    const hostDir = join(this.fixturesRoot, req.hostId);
    if (!existsSync(hostDir)) {
      // Simulated host failure: ssh alias resolution failure for remote
      // hosts (exit 255), command-not-found for local ones (exit 127).
      return done({
        stdout: "",
        stderr:
          req.ssh !== null
            ? `ssh: Could not resolve hostname ${req.ssh}: nodename nor servname provided, or not known`
            : `sh: ccusage: command not found (mock: no fixtures for host ${req.hostId})`,
        exitCode: req.ssh !== null ? 255 : 127,
        timedOut: false,
      });
    }

    const stderr = "npm notice a mock noise line — never merge streams\n";
    if (req.command.includes("--version")) {
      return done({
        stdout: `ccusage ${MOCK_CCUSAGE_VERSION}\n`,
        stderr,
        exitCode: 0,
        timedOut: false,
      });
    }
    if (!req.command.includes("--sections")) {
      return done({
        stdout: "",
        stderr: `${stderr}mock: unrecognized ccusage invocation: ${req.command}\n`,
        exitCode: 2,
        timedOut: false,
      });
    }
    const file = Bun.file(join(hostDir, "unified.json"));
    if (!(await file.exists())) {
      return done({
        stdout: "",
        stderr: `${stderr}mock: missing fixture ${req.hostId}/unified.json\n`,
        exitCode: 1,
        timedOut: false,
      });
    }
    return done({
      stdout: await file.text(),
      stderr,
      exitCode: 0,
      timedOut: false,
    });
  }
}

/** Executor selection for the real server process: MOCK=1 swaps in fixtures. */
export function createExecutor(
  env: Record<string, string | undefined> = process.env,
): CommandExecutor {
  return env["MOCK"] === "1" ? new MockExecutor() : new SystemExecutor();
}
