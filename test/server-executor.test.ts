/** Executor process semantics and unified fixture replay. */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { buildUnifiedFetchCommand } from "../src/server/command";
import {
  createExecutor,
  DEFAULT_FIXTURES_ROOT,
  LocalExecutor,
  MOCK_CCUSAGE_VERSION,
  MockExecutor,
  sshArgv,
  SystemExecutor,
} from "../src/server/executor";
import type { HostConfig } from "../src/shared/types";

const OPTS = {
  since: "2026-04-11",
  until: "2026-07-10",
  timezone: "America/Boise",
};
const HOST: HostConfig = {
  id: "local",
  label: "Local",
  color: "#7c8cf8",
  enabled: true,
  ssh: null,
  ccusageCmd: "bunx ccusage@latest",
};

describe("LocalExecutor", () => {
  test("captures stdout/stderr separately and reports exit code", async () => {
    const res = await new LocalExecutor().run({
      hostId: "local",
      ssh: null,
      command: "printf 'clean'; printf 'noise' 1>&2; exit 3",
      timeoutMs: 5_000,
    });
    expect(res.stdout).toBe("clean");
    expect(res.stderr).toBe("noise");
    expect(res.exitCode).toBe(3);
  });

  test("kills a timed-out process", async () => {
    const res = await new LocalExecutor().run({
      hostId: "local",
      ssh: null,
      command: "sleep 30",
      timeoutMs: 100,
    });
    expect(res.timedOut).toBe(true);
    expect(res.exitCode).toBeNull();
  });
});

test("sshArgv keeps the remote command as one argument", () => {
  expect(sshArgv("clawd", "x --sections daily,monthly,session")).toEqual([
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "clawd",
    "x --sections daily,monthly,session",
  ]);
});

describe("MockExecutor", () => {
  const mock = new MockExecutor(DEFAULT_FIXTURES_ROOT);

  test("replays unified.json for a command containing --sections", async () => {
    const built = buildUnifiedFetchCommand(HOST, OPTS);
    const res = await mock.run({
      hostId: "local",
      ssh: null,
      command: built.command,
      timeoutMs: 180_000,
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(
      await Bun.file(join(DEFAULT_FIXTURES_ROOT, "local", "unified.json")).text(),
    );
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(res.stderr.length).toBeGreaterThan(0);
  });

  test("script-wrapped temp-config command resolves to unified.json", async () => {
    const built = buildUnifiedFetchCommand(
      {
        ...HOST,
        extraSources: [
          { type: "pi-jsonl", agent: "omp", path: "/tmp/omp sessions" },
        ],
      },
      OPTS,
    );
    expect(built.command).toContain("CFG=$(mktemp)");
    const res = await mock.run({
      hostId: "local",
      ssh: null,
      command: built.command,
      timeoutMs: 180_000,
    });
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).daily.length).toBeGreaterThan(0);
  });

  test("answers version and rejects any other invocation", async () => {
    const version = await mock.run({
      hostId: "mm",
      ssh: "mm",
      command: "bunx ccusage@latest --version",
      timeoutMs: 45_000,
    });
    expect(version.stdout).toContain(`ccusage ${MOCK_CCUSAGE_VERSION}`);
    const bad = await mock.run({
      hostId: "local",
      ssh: null,
      command: "bunx ccusage@latest daily --json",
      timeoutMs: 45_000,
    });
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("unrecognized");
  });

  test("unknown hosts retain remote/local failure tiers", async () => {
    const remote = await mock.run({
      hostId: "ghost",
      ssh: "ghost",
      command: "x --sections daily,monthly,session",
      timeoutMs: 1,
    });
    const local = await mock.run({
      hostId: "ghost-local",
      ssh: null,
      command: "x --sections daily,monthly,session",
      timeoutMs: 1,
    });
    expect(remote.exitCode).toBe(255);
    expect(local.exitCode).toBe(127);
  });
});

test("createExecutor selects mock only for MOCK=1", () => {
  expect(createExecutor({ MOCK: "1" })).toBeInstanceOf(MockExecutor);
  expect(createExecutor({})).toBeInstanceOf(SystemExecutor);
});
