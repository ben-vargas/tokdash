/**
 * End-to-end route tests: in-process Hono app + MockExecutor + temp cache +
 * TEMP config file (the real tokdash.config.json is never touched). Usage
 * responses are cross-checked against computeUsage on the same snapshots and
 * against plain-arithmetic sums straight from the fixture JSON.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { SnapshotStore } from "../src/server/cache";
import { DEFAULT_FIXTURES_ROOT, MockExecutor } from "../src/server/executor";
import type { CommandExecutor } from "../src/server/executor";
import { RefreshManager } from "../src/server/refresh";
import { createApp } from "../src/server/routes";
import { requireConfig } from "../src/server/config";
import { computeUsage, resolveUsageFilter } from "../src/shared/aggregate";
import { mergeHosts } from "../src/shared/merge";
import {
  statusResponseSchema,
  testConnectionResponseSchema,
  usageResponseSchema,
} from "../src/shared/schemas";
import type { AppConfig } from "../src/shared/types";

/* ------------------------------- setup ------------------------------- */

const NOW_ISO = "2026-07-02T18:00:00.000Z"; // fixed route clock
const NOW = () => new Date(NOW_ISO);

const BASE_CONFIG: AppConfig = {
  timezone: "America/Boise",
  fetchWindowDays: 90,
  refreshIntervalMinutes: 15,
  hosts: [
    { id: "local", label: "MacBook Pro", color: "#7c8cf8", enabled: true, ssh: null, ccusageCmd: "bunx ccusage@latest", extraSources: [{ type: "pi-jsonl", agent: "omp", path: "/Users/ben/.omp/agent/sessions" }] },
    { id: "mm", label: "Mac mini (ben)", color: "#4ec9b0", enabled: true, ssh: "mm", ccusageCmd: "~/.bun/bin/bunx ccusage@latest", extraSources: [{ type: "pi-jsonl", agent: "omp", path: "/Users/ben/.omp/agent/sessions" }] },
    { id: "clawd", label: "Mac mini (clawd)", color: "#e8a951", enabled: true, ssh: "clawd", ccusageCmd: "npx -y ccusage@latest" },
  ],
};

let rootDir: string;
let configPath: string;
let store: SnapshotStore;
let refresh: RefreshManager;
let app: Hono;

/** A pausable wrapper so tests can hold a refresh open deterministically. */
class GatedExecutor implements CommandExecutor {
  gate: Promise<void> | null = null;
  constructor(private readonly inner: CommandExecutor) {}
  async run(req: Parameters<CommandExecutor["run"]>[0]) {
    if (this.gate !== null) await this.gate;
    return this.inner.run(req);
  }
}
let gated: GatedExecutor;

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), "tokdash-routes-test-"));
  configPath = join(rootDir, "tokdash.config.json");
  writeFileSync(configPath, JSON.stringify(BASE_CONFIG, null, 2));
  store = new SnapshotStore(join(rootDir, "snapshots"), () => {});
  gated = new GatedExecutor(new MockExecutor(DEFAULT_FIXTURES_ROOT));
  refresh = new RefreshManager({
    loadConfig: () => requireConfig(configPath),
    store,
    executor: gated,
    now: NOW,
    log: () => {},
  });
  app = createApp({ configPath, store, refresh, executor: gated, now: NOW });
  await refresh.refresh().promise; // seed the cache from fixtures
});

afterAll(() => {
  refresh.stopScheduler();
  rmSync(rootDir, { recursive: true, force: true });
});

async function getJson(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
}

/* ------------------------------- health ------------------------------ */

describe("GET /api/health", () => {
  test("ok", async () => {
    const { status, body } = await getJson("/api/health");
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
  });
});

/* ------------------------------- config ------------------------------ */

describe("/api/config", () => {
  test("GET returns the config document unredacted", async () => {
    const { status, body } = await getJson("/api/config");
    expect(status).toBe(200);
    expect(body).toEqual(BASE_CONFIG as unknown as Record<string, unknown>);
  });

  test("PUT creates a missing config file and GET round-trips it", async () => {
    unlinkSync(configPath);
    expect(existsSync(configPath)).toBe(false);
    const created: AppConfig = {
      timezone: "UTC",
      fetchWindowDays: 90,
      refreshIntervalMinutes: 15,
      hosts: [
        {
          id: "local",
          label: "Local",
          color: "#7c8cf8",
          enabled: true,
          ssh: null,
          ccusageCmd: "bunx ccusage@latest",
        },
      ],
    };
    try {
      const res = await app.request("/api/config", {
        method: "PUT",
        body: JSON.stringify(created),
        headers: { "content-type": "application/json" },
      });
      expect(res.status).toBe(200);
      expect(existsSync(configPath)).toBe(true);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(created);

      const { status, body } = await getJson("/api/config");
      expect(status).toBe(200);
      expect(body).toEqual(created as unknown as Record<string, unknown>);
    } finally {
      writeFileSync(configPath, JSON.stringify(BASE_CONFIG, null, 2));
    }
  });

  test("PUT rejects an invalid document with 400 and leaves the file untouched", async () => {
    const before = readFileSync(configPath, "utf8");
    const bad = { ...BASE_CONFIG, hosts: [{ id: "x" }] };
    const res = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify(bad),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("config failed validation");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("PUT rejects a regex-passing but non-IANA timezone", async () => {
    const res = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({ ...BASE_CONFIG, timezone: "Not/AZone" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  test("PUT rejects duplicate host ids", async () => {
    const res = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        ...BASE_CONFIG,
        hosts: [...BASE_CONFIG.hosts, BASE_CONFIG.hosts[0]],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  test.each([
    {
      label: "reserved agent",
      sources: [{ type: "pi-jsonl", agent: "pi", path: "/tmp/pi" }],
      message: "reserved",
    },
    {
      label: "duplicate agent",
      sources: [
        { type: "pi-jsonl", agent: "omp", path: "/tmp/a" },
        { type: "pi-jsonl", agent: "omp", path: "/tmp/b" },
      ],
      message: "agent names must be unique",
    },
    {
      label: "duplicate path",
      sources: [
        { type: "pi-jsonl", agent: "omp", path: "/tmp/a" },
        { type: "pi-jsonl", agent: "lab", path: "/tmp/a/" },
      ],
      message: "paths must be unique",
    },
    {
      label: "overlapping path",
      sources: [
        { type: "pi-jsonl", agent: "omp", path: "/tmp/stores" },
        { type: "pi-jsonl", agent: "lab", path: "/tmp/stores/lab" },
      ],
      message: "paths must not overlap",
    },
  ])("PUT rejects $label", async ({ sources, message }) => {
    const res = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        ...BASE_CONFIG,
        hosts: [{ ...BASE_CONFIG.hosts[0], extraSources: sources }],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(message);
  });

  test("PUT rejects an invalid named-store agent shape", async () => {
    const res = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify({
        ...BASE_CONFIG,
        hosts: [
          {
            ...BASE_CONFIG.hosts[0],
            extraSources: [
              { type: "pi-jsonl", agent: "Bad Agent", path: "/tmp/a" },
            ],
          },
        ],
      }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("agent");
  });

  test("PUT rejects a non-JSON body with 400", async () => {
    const res = await app.request("/api/config", { method: "PUT", body: "{nope" });
    expect(res.status).toBe(400);
  });

  test("PUT writes a valid document atomically and GET reflects it immediately", async () => {
    const updated: AppConfig = {
      ...BASE_CONFIG,
      refreshIntervalMinutes: 30,
      hosts: [
        ...BASE_CONFIG.hosts,
        { id: "new-host", label: "New", color: "#aabbcc", enabled: false, ssh: "new", ccusageCmd: "bunx ccusage@latest" },
      ],
    };
    const res = await app.request("/api/config", {
      method: "PUT",
      body: JSON.stringify(updated),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; config: AppConfig };
    expect(body.ok).toBe(true);
    expect(body.config.refreshIntervalMinutes).toBe(30);

    // atomic: no temp files left beside the config
    expect(readdirSync(rootDir).filter((f) => f.includes(".tmp"))).toEqual([]);
    // persisted + fresh read on the next request (added host needs no restart)
    const { body: got } = await getJson("/api/config");
    expect((got as AppConfig).hosts.map((h) => h.id)).toContain("new-host");
    const { body: status } = await getJson("/api/status");
    const parsed = statusResponseSchema.parse(status);
    expect(parsed.hosts.map((h) => h.hostId)).toContain("new-host");
    expect(parsed.hosts.find((h) => h.hostId === "new-host")?.freshness).toBe("never");

    // restore for the remaining tests
    writeFileSync(configPath, JSON.stringify(BASE_CONFIG, null, 2));
  });

  test("an invalid config file on disk => clear 500, not a crash", async () => {
    const before = readFileSync(configPath, "utf8");
    writeFileSync(configPath, "{ this is not json");
    try {
      for (const path of ["/api/config", "/api/usage", "/api/status"]) {
        const { status, body } = await getJson(path);
        expect(status).toBe(500);
        expect((body as { error: string }).error).toContain("not valid JSON");
      }
    } finally {
      writeFileSync(configPath, before);
    }
  });
});

/* -------------------------------- usage ------------------------------ */

describe("GET /api/usage", () => {
  test("June window: schema-valid and matches the unified fixture anchor", async () => {
    const { status, body } = await getJson("/api/usage?from=2026-06-01&to=2026-07-01");
    expect(status).toBe(200);
    const usage = usageResponseSchema.parse(body);
    // independent plain-arithmetic recomputation straight from the fixtures
    let expected = 0;
    for (const host of ["local", "mm", "clawd"]) {
      const daily = JSON.parse(
        readFileSync(join(DEFAULT_FIXTURES_ROOT, host, "unified.json"), "utf8"),
      ) as { daily: { period: string; totalCost: number }[] };
      for (const row of daily.daily) {
        if (row.period >= "2026-06-01" && row.period <= "2026-07-01") {
          expected += row.totalCost;
        }
      }
    }
    expect(usage.totals.cost).toBeCloseTo(expected, 6);
    expect(usage.totals.cost).toBeCloseTo(5469.01587317, 6);
    expect(usage.filter).toEqual({
      from: "2026-06-01",
      to: "2026-07-01",
      hosts: ["local", "mm", "clawd"],
      agents: usage.availableAgents,
      allHosts: true,
      allAgents: true,
    });
    expect(usage.dateAxis.length).toBe(31);
    expect(usage.dateAxis[0]).toBe("2026-06-01");
    expect(usage.dateAxis.at(-1)).toBe("2026-07-01");
    expect(usage.availableHosts.map((h) => h.id)).toEqual(["local", "mm", "clawd"]);
  });

  test("response is byte-identical to computeUsage over the same snapshots (single aggregation path)", async () => {
    const { body } = await getJson("/api/usage?from=2026-06-01&to=2026-07-01");
    const config = requireConfig(configPath);
    const dataset = mergeHosts(
      config.hosts.map((host) => ({ host, snapshot: store.get(host.id) })),
    );
    const resolved = resolveUsageFilter({ from: "2026-06-01", to: "2026-07-01" }, "2026-07-02");
    if (!resolved.ok) throw new Error(resolved.error);
    const direct = computeUsage(dataset, resolved.filter, {
      today: "2026-07-02",
      timezone: "America/Boise",
      generatedAt: NOW_ISO,
    });
    expect(body).toEqual(JSON.parse(JSON.stringify(direct)));
  });

  test("hosts filter: clawd only", async () => {
    const { body } = await getJson("/api/usage?from=2026-06-01&to=2026-07-01&hosts=clawd");
    const usage = usageResponseSchema.parse(body);
    const daily = JSON.parse(
      readFileSync(join(DEFAULT_FIXTURES_ROOT, "clawd", "unified.json"), "utf8"),
    ) as { daily: { period: string; totalCost: number }[] };
    let expected = 0;
    for (const row of daily.daily) {
      if (row.period >= "2026-06-01" && row.period <= "2026-07-01") expected += row.totalCost;
    }
    expect(usage.totals.cost).toBeCloseTo(expected, 6);
    expect(usage.filter.hosts).toEqual(["clawd"]);
    expect(usage.filter.allHosts).toBe(false);
  });

  test("agents filter: hermes on clawd matches unified daily slices", async () => {
    const { body } = await getJson(
      "/api/usage?from=2026-06-01&to=2026-07-01&hosts=clawd&agents=hermes",
    );
    const usage = usageResponseSchema.parse(body);
    const agentDaily = JSON.parse(
      readFileSync(join(DEFAULT_FIXTURES_ROOT, "clawd", "unified.json"), "utf8"),
    ) as {
      daily: Array<{
        period: string;
        agents: Array<{ agent: string; totalCost: number }>;
      }>;
    };
    let expected = 0;
    for (const row of agentDaily.daily) {
      if (row.period < "2026-06-01" || row.period > "2026-07-01") continue;
      expected += row.agents.find((slice) => slice.agent === "hermes")?.totalCost ?? 0;
    }
    expect(usage.totals.cost).toBeCloseTo(expected, 6);
    expect(usage.totals.cost).toBeCloseTo(69.99167117, 6);
    expect(usage.filter.allAgents).toBe(false);
    expect(usage.filter.agents).toEqual(["hermes"]);
    // hermes-only across ALL hosts contributes ~nothing from local/mm
    const { body: allHosts } = await getJson(
      "/api/usage?from=2026-06-01&to=2026-07-01&agents=hermes",
    );
    const usageAll = usageResponseSchema.parse(allHosts);
    expect(usageAll.totals.cost).toBeCloseTo(expected, 6);
  });

  test("wire conventions: omitted `to` = today, omitted `from` = 30d default", async () => {
    const { body } = await getJson("/api/usage");
    const usage = usageResponseSchema.parse(body);
    expect(usage.filter.to).toBe("2026-07-02");
    expect(usage.filter.from).toBe("2026-06-03"); // today − 29
    expect(usage.dateAxis.length).toBe(30);
  });

  test("comma-separated lists are trimmed and deduped; unknown ids are not errors", async () => {
    const { status, body } = await getJson(
      "/api/usage?hosts=%20local%20,local,ghost&agents=claude,%20claude",
    );
    expect(status).toBe(200);
    const usage = usageResponseSchema.parse(body);
    expect(usage.filter.hosts).toEqual(["local"]); // ghost isn't configured
    expect(usage.filter.agents).toEqual(["claude"]);
  });

  test("bad params => 400 with a reason", async () => {
    for (const q of ["from=junk", "from=2026-06-31", "from=2026-07-01&to=2026-06-01"]) {
      const { status, body } = await getJson(`/api/usage?${q}`);
      expect(status).toBe(400);
      expect(typeof (body as { error: string }).error).toBe("string");
    }
  });

  test("a `from` older than the cached window kicks a background wider refetch", async () => {
    const windowBefore = store.get("local")?.window.from;
    expect(windowBefore).toBe("2026-04-03"); // today − 90
    const { status } = await getJson("/api/usage?from=2026-02-01&to=2026-07-01");
    expect(status).toBe(200); // served from cache immediately
    await refresh.refresh().promise; // join the background refetch
    expect(store.get("local")?.window.from).toBe("2026-02-01");
  });
});

/* ------------------------------- refresh ----------------------------- */

describe("POST /api/refresh", () => {
  test("202 immediately; single-flight over HTTP", async () => {
    let release!: () => void;
    gated.gate = new Promise<void>((r) => {
      release = r;
    });
    try {
      const first = await app.request("/api/refresh", { method: "POST" });
      expect(first.status).toBe(202);
      expect(await first.json()).toEqual({ started: true, alreadyRunning: false });

      const second = await app.request("/api/refresh", { method: "POST" });
      expect(second.status).toBe(202);
      expect(await second.json()).toEqual({ started: false, alreadyRunning: true });

      const { body: status } = await getJson("/api/status");
      expect(statusResponseSchema.parse(status).refreshing).toBe(true);
    } finally {
      release();
      gated.gate = null;
    }
    await refresh.refresh().promise; // drain
    const { body: after } = await getJson("/api/status");
    expect(statusResponseSchema.parse(after).refreshing).toBe(false);
  });
});

/* -------------------------------- status ----------------------------- */

describe("GET /api/status", () => {
  test("per-host freshness, durations, agents", async () => {
    const { status, body } = await getJson("/api/status");
    expect(status).toBe(200);
    const parsed = statusResponseSchema.parse(body);
    expect(parsed.generatedAt).toBe(NOW_ISO);
    expect(parsed.hosts.length).toBe(3);
    for (const host of parsed.hosts) {
      expect(host.freshness).toBe("fresh"); // snapshots stamped with the same fake clock
      expect(host.error).toBeNull();
      expect(host.durations.length).toBe(1); // one unified invocation
      expect(host.agents.length).toBeGreaterThan(0);
    }
    expect(parsed.hosts.find((h) => h.hostId === "clawd")?.agents).toContain("hermes");
  });

  test("a failed host shows an error state (and /api/usage still serves the rest)", async () => {
    const withGhost: AppConfig = {
      ...BASE_CONFIG,
      hosts: [
        ...BASE_CONFIG.hosts,
        { id: "ghost", label: "Ghost", color: "#ff0000", enabled: true, ssh: "ghost", ccusageCmd: "bunx ccusage@latest" },
      ],
    };
    writeFileSync(configPath, JSON.stringify(withGhost, null, 2));
    try {
      await refresh.refresh().promise;
      const { body } = await getJson("/api/status");
      const parsed = statusResponseSchema.parse(body);
      const ghost = parsed.hosts.find((h) => h.hostId === "ghost");
      expect(ghost?.freshness).toBe("error");
      expect(ghost?.error?.kind).toBe("unreachable");
      expect(ghost?.error?.stderrTail).toContain("Could not resolve hostname");
      expect(parsed.hosts.find((h) => h.hostId === "local")?.freshness).toBe("fresh");

      const { body: usage } = await getJson("/api/usage?from=2026-06-01&to=2026-07-01");
      const parsedUsage = usageResponseSchema.parse(usage);
      expect(parsedUsage.totals.cost).toBeCloseTo(5469.01587317, 6);
    } finally {
      writeFileSync(configPath, JSON.stringify(BASE_CONFIG, null, 2));
      await refresh.refresh().promise; // restore fresh 3-host snapshots
    }
  });
});

/* --------------------------- test connection ------------------------- */

describe("POST /api/hosts/:id/test", () => {
  test("reports round-trip, version, and detected agents from the snapshot", async () => {
    const res = await app.request("/api/hosts/clawd/test", { method: "POST" });
    expect(res.status).toBe(200);
    const body = testConnectionResponseSchema.parse(await res.json());
    expect(body.ok).toBe(true);
    expect(body.ccusageVersion).toBe("20.0.16");
    expect(body.roundTripMs).toBeGreaterThanOrEqual(0);
    expect(body.detectedAgents).toContain("hermes");
    expect(body.error).toBeNull();
  });

  test("unknown host id => 404", async () => {
    const res = await app.request("/api/hosts/nope/test", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("unreachable host => ok:false with exit code and stderr surfaced", async () => {
    const withGhost: AppConfig = {
      ...BASE_CONFIG,
      hosts: [
        ...BASE_CONFIG.hosts,
        { id: "ghost", label: "Ghost", color: "#ff0000", enabled: true, ssh: "ghost", ccusageCmd: "bunx ccusage@latest" },
      ],
    };
    writeFileSync(configPath, JSON.stringify(withGhost, null, 2));
    try {
      const res = await app.request("/api/hosts/ghost/test", { method: "POST" });
      expect(res.status).toBe(200);
      const body = testConnectionResponseSchema.parse(await res.json());
      expect(body.ok).toBe(false);
      expect(body.exitCode).toBe(255);
      expect(body.stderrTail).toContain("Could not resolve hostname");
      expect(body.error).toContain("255");
    } finally {
      writeFileSync(configPath, JSON.stringify(BASE_CONFIG, null, 2));
    }
  });
});

/* ----------------------------- api fallback -------------------------- */

describe("unknown /api routes", () => {
  test("404 JSON, never the SPA fallback", async () => {
    const { status, body } = await getJson("/api/definitely-not-a-route");
    expect(status).toBe(404);
    expect((body as { error: string }).error).toContain("no such API route");
  });
});
