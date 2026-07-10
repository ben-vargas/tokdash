/**
 * TokDash server entrypoint.
 *
 *   PORT=4114 (default)            bound to 127.0.0.1 only
 *   MOCK=1                         swap the executor for fixture replay —
 *                                  cache, refresh, routes and aggregation run
 *                                  IDENTICALLY (mock snapshots go to
 *                                  .cache/snapshots-mock so live cache stays
 *                                  clean; override with TOKDASH_CACHE_DIR)
 *   TOKDASH_CONFIG=<path>          config file override
 *   TOKDASH_AUTOREFRESH=0          pause the auto-refresh scheduler (G6);
 *                                  refreshIntervalMinutes <= 0 in config also
 *                                  disables it
 *
 * Startup: serve immediately (stale-while-revalidate — cached snapshots
 * render instantly), then kick a background refresh when any enabled host
 * has no snapshot or a stale one. In MOCK mode that initial refresh is
 * awaited before listening (it is fixture-fast), so probes right after boot
 * see real data deterministically.
 *
 * NOTE: named exports only — a default export with a fetch method would make
 * Bun auto-serve a SECOND server.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { staleAfterMs } from "../shared/constants";
import { SnapshotStore } from "./cache";
import { requireConfig, readConfigFile, resolveConfig } from "./config";
import { createExecutor } from "./executor";
import { RefreshManager } from "./refresh";
import { createApp } from "./routes";

const MOCK = process.env.MOCK === "1";
const configResolution = resolveConfig();
const configPath = configResolution.path;
const snapshotDirName = MOCK ? "snapshots-mock" : "snapshots";
const cacheDir = resolve(
  process.env.TOKDASH_CACHE_DIR ??
    (configResolution.source === "xdg"
      ? join(
          process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
          "tokdash",
          snapshotDirName,
        )
      : join(".cache", snapshotDirName)),
);

const executor = createExecutor();
const store = new SnapshotStore(cacheDir);
const refresh = new RefreshManager({
  loadConfig: () => requireConfig(configPath),
  store,
  executor,
});

const distDir = join(import.meta.dir, "..", "..", "dist");
const app = createApp({
  configPath,
  store,
  refresh,
  executor,
  distDir: existsSync(distDir) ? distDir : null,
});

const port = Number(process.env.PORT) || 4114;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: app.fetch,
});

console.log(
  `TokDash server listening on http://127.0.0.1:${server.port}` +
    (MOCK ? " (MOCK mode: replaying fixtures/real)" : ""),
);
console.log(`[startup] config: ${configPath} | cache: ${cacheDir}`);

/* ---- initial refresh (background; awaited in MOCK for determinism) ---- */

function needsInitialRefresh(): boolean {
  const cfg = readConfigFile(configPath);
  if (!cfg.ok) {
    console.error(`[startup] config unusable: ${cfg.error}`);
    return false;
  }
  const staleMs = staleAfterMs(cfg.config.refreshIntervalMinutes);
  return cfg.config.hosts.some((host) => {
    if (!host.enabled) return false;
    const snap = store.get(host.id);
    if (snap === null || snap.error !== null) return true;
    const age = Date.now() - Date.parse(snap.fetchedAt);
    return !Number.isFinite(age) || age > staleMs;
  });
}

if (needsInitialRefresh()) {
  const run = refresh.refresh();
  if (run.started) console.log("[startup] background refresh kicked");
  if (MOCK) await run.promise; // fixture replay: completes in milliseconds
}

/* ------------------------- auto-refresh scheduler ---------------------- */

const autoRefreshPaused = process.env.TOKDASH_AUTOREFRESH === "0";
if (autoRefreshPaused) {
  console.log("[startup] auto-refresh paused (TOKDASH_AUTOREFRESH=0)");
} else {
  refresh.startScheduler();
}

export { app, server, store, refresh };
