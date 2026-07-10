/**
 * Hono app + API routes (FR6). Wire conventions: hosts/agents are
 * comma-separated ids, omitted = all; from/to are inclusive YYYY-MM-DD in
 * the config tz, omitted to = today. GET /api/usage answers from cached
 * snapshots via the ONE aggregation path (mergeHosts → resolveUsageFilter →
 * computeUsage from src/shared) and NEVER triggers SSH — except the §3.2
 * wider-window exception, which kicks a BACKGROUND refetch while serving
 * what the cache has. Every response body is zod-validated against the
 * shared schemas before sending (a validation failure is a loud 500 — it
 * indicates a server bug, not a client one).
 */

import { existsSync } from "node:fs";
import { Hono } from "hono";
import type { Context } from "hono";
import { serveStatic } from "hono/bun";
import type { z } from "zod";
import { INVOCATION_TIMEOUT_MS, staleAfterMs } from "../shared/constants";
import { compareDates, todayInTz } from "../shared/dates";
import { mergeHosts } from "../shared/merge";
import { computeUsage, resolveUsageFilter } from "../shared/aggregate";
import {
  configPutResponseSchema,
  refreshResponseSchema,
  statusResponseSchema,
  testConnectionResponseSchema,
  usageResponseSchema,
} from "../shared/schemas";
import type {
  HostMergeInput,
  HostStatus,
  StatusResponse,
  TestConnectionResponse,
  UsageQuery,
} from "../shared/types";
import type { SnapshotStore } from "./cache";
import { readConfigFile, validateConfig, writeConfigFile } from "./config";
import { buildVersionCommand } from "./command";
import type { CommandExecutor } from "./executor";
import { stderrTail } from "./fetcher";
import type { RefreshManager } from "./refresh";

export interface AppDeps {
  configPath: string;
  store: SnapshotStore;
  refresh: RefreshManager;
  executor: CommandExecutor;
  /** Injectable clock (tests) — drives `today` and generatedAt. */
  now?: () => Date;
  /** Absolute dist/ dir to serve statically; null/missing = API only. */
  distDir?: string | null;
}

type StatusCode = 200 | 202 | 400 | 404 | 500;

export function createApp(deps: AppDeps): Hono {
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  const jsonError = (
    c: Context,
    status: StatusCode,
    error: string,
    details?: unknown,
  ) =>
    c.json(details === undefined ? { error } : { error, details }, status);

  /** Validate a response body against its shared schema before sending. */
  const send = <T>(
    c: Context,
    schema: z.ZodType<T>,
    body: T,
    status: StatusCode = 200,
  ) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      console.error(
        `[routes] response failed schema validation: ${parsed.error.message}`,
      );
      return jsonError(c, 500, "response failed schema validation (server bug)", {
        issues: parsed.error.issues,
      });
    }
    return c.json(parsed.data as unknown as Record<string, unknown>, status);
  };

  /* ----------------------------- health ------------------------------ */

  app.get("/api/health", (c) => c.json({ ok: true }));

  /* ----------------------------- config ------------------------------ */

  app.get("/api/config", (c) => {
    const result = readConfigFile(deps.configPath);
    if (!result.ok) return jsonError(c, 500, result.error);
    return c.json(result.config);
  });

  app.put("/api/config", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return jsonError(c, 400, "request body is not valid JSON");
    }
    const validated = validateConfig(body);
    if (!validated.ok) return jsonError(c, 400, validated.error);
    try {
      const written = await writeConfigFile(deps.configPath, validated.config);
      return send(c, configPutResponseSchema, { ok: true, config: written });
    } catch (err) {
      return jsonError(c, 500, `failed to write config: ${String(err)}`);
    }
  });

  /* ------------------------------ usage ------------------------------ */

  app.get("/api/usage", (c) => {
    const cfg = readConfigFile(deps.configPath);
    if (!cfg.ok) return jsonError(c, 500, cfg.error);
    const config = cfg.config;

    const query: UsageQuery = {
      from: c.req.query("from"),
      to: c.req.query("to"),
      hosts: c.req.query("hosts"),
      agents: c.req.query("agents"),
    };
    const today = todayInTz(config.timezone, now());
    const resolved = resolveUsageFilter(query, today);
    if (!resolved.ok) return jsonError(c, 400, resolved.error);

    const inputs: HostMergeInput[] = config.hosts.map((host) => ({
      host,
      snapshot: deps.store.get(host.id),
    }));

    // §3.2 wider-window exception: a `from` older than any cached window
    // kicks a background refetch; this request is still served from cache.
    const needsWider = inputs.some(
      (i) =>
        i.host.enabled &&
        i.snapshot !== null &&
        compareDates(resolved.filter.from, i.snapshot.window.from) < 0,
    );
    if (needsWider) deps.refresh.requestWiderWindow(resolved.filter.from);

    const dataset = mergeHosts(inputs);
    const response = computeUsage(dataset, resolved.filter, {
      today,
      timezone: config.timezone,
      generatedAt: now().toISOString(),
    });
    return send(c, usageResponseSchema, response);
  });

  /* ----------------------------- refresh ----------------------------- */

  app.post("/api/refresh", (c) => {
    const run = deps.refresh.refresh();
    void run.promise;
    return send(
      c,
      refreshResponseSchema,
      { started: run.started, alreadyRunning: run.alreadyRunning },
      202,
    );
  });

  /* ------------------------------ status ----------------------------- */

  app.get("/api/status", (c) => {
    const cfg = readConfigFile(deps.configPath);
    if (!cfg.ok) return jsonError(c, 500, cfg.error);
    const config = cfg.config;
    const nowDate = now();
    const staleMs = staleAfterMs(config.refreshIntervalMinutes);

    const hosts: HostStatus[] = config.hosts.map((host) => {
      const snapshot = deps.store.get(host.id);
      const fetchedAtMs = snapshot ? Date.parse(snapshot.fetchedAt) : Number.NaN;
      const ageMs =
        snapshot && Number.isFinite(fetchedAtMs)
          ? Math.max(0, nowDate.getTime() - fetchedAtMs)
          : null;
      const freshness =
        snapshot === null
          ? "never"
          : snapshot.error !== null
            ? "error"
            : ageMs !== null && ageMs <= staleMs
              ? "fresh"
              : "stale";
      return {
        hostId: host.id,
        label: host.label,
        color: host.color,
        enabled: host.enabled,
        freshness,
        fetchedAt: snapshot?.fetchedAt ?? null,
        ageMs,
        refreshing: deps.refresh.isHostRefreshing(host.id),
        durations:
          snapshot?.commands.map((cmd) => ({
            name: cmd.name,
            durationMs: cmd.durationMs,
          })) ?? [],
        agents: snapshot?.data.agents ?? [],
        error: snapshot?.error
          ? {
              kind: snapshot.error.kind,
              message: snapshot.error.message,
              stderrTail: snapshot.error.stderrTail,
            }
          : null,
      };
    });

    const body: StatusResponse = {
      refreshing: deps.refresh.isRefreshing(),
      generatedAt: nowDate.toISOString(),
      hosts,
    };
    return send(c, statusResponseSchema, body);
  });

  /* -------------------------- test connection ------------------------ */

  app.post("/api/hosts/:id/test", async (c) => {
    const cfg = readConfigFile(deps.configPath);
    if (!cfg.ok) return jsonError(c, 500, cfg.error);
    const hostId = c.req.param("id");
    const host = cfg.config.hosts.find((h) => h.id === hostId);
    if (host === undefined) {
      return jsonError(c, 404, `no configured host with id ${JSON.stringify(hostId)}`);
    }
    const cmd = buildVersionCommand(host.ccusageCmd);
    const res = await deps.executor.run({
      hostId: host.id,
      ssh: host.ssh,
      command: cmd.command,
      timeoutMs: INVOCATION_TIMEOUT_MS,
    });
    const version = /(\d+\.\d+\.\d+[^\s]*)/.exec(res.stdout)?.[1] ?? null;
    const ok = !res.timedOut && res.exitCode === 0;
    const body: TestConnectionResponse = {
      ok,
      hostId: host.id,
      roundTripMs: Math.round(res.durationMs),
      ccusageVersion: version,
      // Cheap by design: --version only; agents come from the latest snapshot.
      detectedAgents: deps.store.get(host.id)?.data.agents ?? [],
      exitCode: res.exitCode,
      stderrTail: stderrTail(res.stderr),
      error: ok
        ? null
        : res.timedOut
          ? `timed out after ${Math.round(res.durationMs)}ms`
          : `exit code ${res.exitCode ?? "none"} (255 = ssh failure, 127 = command not found)`,
    };
    return send(c, testConnectionResponseSchema, body);
  });

  /* --------------------- unknown /api + static SPA ------------------- */

  app.all("/api/*", (c) => jsonError(c, 404, `no such API route: ${c.req.path}`));

  const distDir = deps.distDir ?? null;
  if (distDir !== null && existsSync(distDir)) {
    // serveStatic resolves `root` relative to process.cwd(); the server is
    // always started from the repo root (bun start / scripts/dev.ts).
    app.use("/*", serveStatic({ root: "./dist" }));
    // SPA fallback: any non-/api GET falls back to index.html.
    app.get("*", serveStatic({ path: "./dist/index.html" }));
  }

  return app;
}
