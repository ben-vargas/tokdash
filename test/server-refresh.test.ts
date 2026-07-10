/** Unified fetch degradation rules and RefreshManager single-flight behavior. */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore } from "../src/server/cache";
import {
  DEFAULT_FIXTURES_ROOT,
  MockExecutor,
} from "../src/server/executor";
import type { CommandExecutor, ExecRequest, ExecResult } from "../src/server/executor";
import { classifyHostFailure, fetchHostSnapshot, stderrTail } from "../src/server/fetcher";
import { RefreshManager } from "../src/server/refresh";
import type { AppConfig, HostConfig } from "../src/shared/types";

const tempDirs: string[] = [];
function tempStore(): SnapshotStore {
  const dir = mkdtempSync(join(tmpdir(), "tokdash-refresh-test-"));
  tempDirs.push(dir);
  return new SnapshotStore(dir, () => {});
}
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

const NOW = () => new Date("2026-07-10T18:00:00.000Z");
const WINDOW = { from: "2026-04-11", to: "2026-07-10" };

const LOCAL: HostConfig = {
  id: "local",
  label: "MacBook Pro",
  color: "#7c8cf8",
  enabled: true,
  ssh: null,
  ccusageCmd: "bunx ccusage@latest",
  extraSources: [
    { type: "pi-jsonl", agent: "omp", path: "/Users/ben/.omp/agent/sessions" },
  ],
};
const CLAWD: HostConfig = {
  id: "clawd",
  label: "Mac mini (clawd)",
  color: "#e8a951",
  enabled: true,
  ssh: "clawd",
  ccusageCmd: "npx -y ccusage@latest",
};
const MM: HostConfig = {
  id: "mm",
  label: "Mac mini (ben)",
  color: "#4ec9b0",
  enabled: true,
  ssh: "mm",
  ccusageCmd: "~/.bun/bin/bunx ccusage@latest",
  extraSources: [
    { type: "pi-jsonl", agent: "omp", path: "/Users/ben/.omp/agent/sessions" },
  ],
};

function fetch(host: HostConfig, executor: CommandExecutor, previous = null) {
  return fetchHostSnapshot(host, {
    timezone: "America/Boise",
    window: WINDOW,
    executor,
    now: NOW,
    previous,
  });
}

function failingExecutor(
  exitCode: number | null,
  timedOut = false,
): CommandExecutor {
  return {
    run: async () => ({
      stdout: "",
      stderr: "ssh: connect failed",
      exitCode,
      durationMs: 5,
      timedOut,
    }),
  };
}

describe("fetchHostSnapshot", () => {
  const mock = new MockExecutor(DEFAULT_FIXTURES_ROOT);

  test("uses exactly one unified CommandRecord and derives local agentDaily keys", async () => {
    const snap = await fetch(LOCAL, mock);
    expect(snap.error).toBeNull();
    expect(snap.commands).toHaveLength(1);
    expect(snap.commands[0]?.name).toBe("unified");
    expect(snap.commands[0]?.argv).toContain("--sections");
    expect(snap.raw.unified).not.toBeNull();
    expect(Object.keys(snap.data.agentDaily).sort()).toEqual([
      "claude",
      "codex",
      "droid",
      "omp",
      "opencode",
      "pi",
    ]);
  });

  test("omp slice has real per-model costs with bare slugs", async () => {
    const snap = await fetch(LOCAL, mock);
    const rows = snap.data.agentDaily["omp"] ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => (row.modelBreakdowns ?? []).some((b) => b.cost > 0))).toBe(
      true,
    );
    expect(JSON.stringify(rows)).not.toContain("[omp] ");
    expect(rows.every((row) => row.dialect === "unified")).toBe(true);
  });

  test("mm silently omits its missing configured omp store", async () => {
    const snap = await fetch(MM, mock);
    expect(snap.error).toBeNull();
    expect(snap.data.agentDaily["omp"]).toBeUndefined();
    expect(snap.data.agents).not.toContain("omp");
    expect(
      snap.warnings.some(
        (w) => w.code === "unknown-agent" && w.context?.["agent"] === "omp",
      ),
    ).toBe(false);
  });

  test("real local date total equals the sum of agent-slice model costs", async () => {
    const snap = await fetch(LOCAL, mock);
    const date = "2026-07-01";
    const hostCost = snap.data.daily.find((row) => row.date === date)?.cost;
    const modelCost = Object.values(snap.data.agentDaily)
      .flat()
      .filter((row) => row.date === date)
      .flatMap((row) => row.modelBreakdowns ?? [])
      .reduce((sum, row) => sum + row.cost, 0);
    expect(hostCost).toBeDefined();
    expect(modelCost).toBeCloseTo(hostCost as number, 9);
  });

  test("configured store names suppress unknown warnings but genuine unknowns warn once", async () => {
    const slice = (agent: string) => ({
      agent,
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 3,
      totalCost: 0.1,
      modelsUsed: [],
      modelBreakdowns: [],
    });
    const session = (agent: string) => ({
      ...slice(agent),
      period: `${agent}-session`,
      metadata: null,
    });
    const stdout = JSON.stringify({
      daily: [
        {
          ...slice("all"),
          agent: "all",
          period: "2026-07-10",
          metadata: { agents: ["omp", "warpspeed"] },
          agents: [slice("omp"), slice("warpspeed")],
        },
      ],
      monthly: [],
      session: [session("omp"), session("warpspeed")],
      totals: slice("all"),
    });
    const executor: CommandExecutor = {
      run: async () => ({
        stdout,
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
      }),
    };
    const snap = await fetch(LOCAL, executor);
    expect(
      snap.warnings.some(
        (w) => w.code === "unknown-agent" && w.context?.["agent"] === "omp",
      ),
    ).toBe(false);
    expect(
      snap.warnings.filter(
        (w) =>
          w.code === "unknown-agent" && w.context?.["agent"] === "warpspeed",
      ),
    ).toHaveLength(1);
  });

  test("garbled unified output degrades to the previous snapshot", async () => {
    const good = await fetch(CLAWD, mock);
    const garbled: CommandExecutor = {
      run: async () => ({
        stdout: "Error: no JSON today",
        stderr: "npm noise",
        exitCode: 0,
        durationMs: 2,
        timedOut: false,
      }),
    };
    const degraded = await fetchHostSnapshot(CLAWD, {
      timezone: "America/Boise",
      window: WINDOW,
      executor: garbled,
      now: () => new Date("2026-07-10T19:00:00.000Z"),
      previous: good,
    });
    expect(degraded.error?.kind).toBe("bad-json");
    expect(degraded.error?.message).toContain("unified stdout did not parse");
    expect(degraded.commands).toHaveLength(1);
    expect(degraded.data).toEqual(good.data);
    expect(degraded.raw).toEqual(good.raw);
    expect(degraded.fetchedAt).toBe(good.fetchedAt);
  });

  test("valid JSON with an invalid envelope degrades as schema failure", async () => {
    const executor: CommandExecutor = {
      run: async () => ({
        stdout: '{"daily":[]}',
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        timedOut: false,
      }),
    };
    const snap = await fetch(CLAWD, executor);
    expect(snap.error?.kind).toBe("schema");
    expect(snap.data.daily).toEqual([]);
  });

  test("transport failures preserve the established tiers", async () => {
    expect((await fetch(CLAWD, failingExecutor(255))).error?.kind).toBe(
      "unreachable",
    );
    expect((await fetch(CLAWD, failingExecutor(127))).error?.kind).toBe("exit");
    expect((await fetch(CLAWD, failingExecutor(null, true))).error?.kind).toBe(
      "timeout",
    );
  });
});

describe("failure helpers", () => {
  test("classifyHostFailure maps exit codes", () => {
    const base: ExecResult = {
      stdout: "",
      stderr: "boom",
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
    };
    const at = "2026-07-10T18:00:00.000Z";
    expect(classifyHostFailure(base, at)).toBeNull();
    expect(classifyHostFailure({ ...base, exitCode: 2 }, at)?.message).toContain(
      "argument error",
    );
  });

  test("stderrTail keeps only the diagnostic tail", () => {
    expect(stderrTail("short")).toBe("short");
    expect(stderrTail("x".repeat(1000))).toHaveLength(500);
  });
});

describe("RefreshManager", () => {
  const CONFIG: AppConfig = {
    timezone: "America/Boise",
    fetchWindowDays: 90,
    refreshIntervalMinutes: 15,
    hosts: [LOCAL, CLAWD],
  };

  test("single-flight refresh executes once per host", async () => {
    const store = tempStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = new MockExecutor(DEFAULT_FIXTURES_ROOT);
    let runCount = 0;
    const executor: CommandExecutor = {
      run: async (req) => {
        runCount += 1;
        await gate;
        return inner.run(req);
      },
    };
    const manager = new RefreshManager({
      loadConfig: () => CONFIG,
      store,
      executor,
      now: NOW,
      log: () => {},
    });
    const first = manager.refresh();
    const second = manager.refresh();
    expect(second.alreadyRunning).toBe(true);
    expect(second.promise).toBe(first.promise);
    release();
    await first.promise;
    expect(runCount).toBe(2);
    expect(store.get("local")?.commands).toHaveLength(1);
    expect(store.get("clawd")?.commands).toHaveLength(1);
  });

  test("requestWiderWindow reaches the one unified command", async () => {
    const store = tempStore();
    const commands: ExecRequest[] = [];
    const inner = new MockExecutor(DEFAULT_FIXTURES_ROOT);
    const executor: CommandExecutor = {
      run: async (req) => {
        commands.push(req);
        return inner.run(req);
      },
    };
    const manager = new RefreshManager({
      loadConfig: () => CONFIG,
      store,
      executor,
      now: NOW,
      log: () => {},
    });
    expect(manager.requestWiderWindow("2026-01-15")).toBe(true);
    await manager.refresh().promise;
    expect(commands).toHaveLength(2);
    expect(commands.every((req) => req.command.includes("-s 2026-01-15"))).toBe(
      true,
    );
  });

  test("unusable config is a logged no-op", async () => {
    const store = tempStore();
    const manager = new RefreshManager({
      loadConfig: () => {
        throw new Error("invalid config");
      },
      store,
      executor: failingExecutor(0),
      now: NOW,
      log: () => {},
    });
    await manager.refresh().promise;
    expect(store.get("local")).toBeNull();
  });
});
