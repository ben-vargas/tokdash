/**
 * Refresh orchestration:
 *
 *   - parallel across enabled hosts (Promise.all over independent fetches)
 *   - SINGLE-FLIGHT: a refresh requested while one runs JOINS it — callers
 *     get the same promise back ({ started:false, alreadyRunning:true })
 *   - interval scheduler driven by config refreshIntervalMinutes, re-read
 *     before every tick so hand edits take effect. refreshIntervalMinutes
 *     of 0 / absent => auto-refresh DISABLED (the shared config schema
 *     currently enforces 1..1440, but the scheduler is defensive). A
 *     transiently UNREADABLE config keeps the scheduler alive with a 60s
 *     config-reread retry (hand edits must recover without a restart).
 *     The server additionally honors TOKDASH_AUTOREFRESH=0 at startup
 *     (never calls startScheduler) — that is the G6 "pause auto-refresh"
 *     switch.
 *   - timers are injectable so tests never leave real timers running.
 *   - targeted wider refetch: requestWiderWindow(from) kicks a background
 *     refresh whose --since reaches back to `from` (used by GET /api/usage
 *     when the requested range predates the cached window).
 */

import { DEFAULT_REFRESH_INTERVAL_MINUTES } from "../shared/constants";
import { addDays, compareDates, minDate, todayInTz } from "../shared/dates";
import type { AppConfig, DateString, HostSnapshot } from "../shared/types";
import { emptyHostUsageData } from "../shared/merge";
import type { SnapshotStore } from "./cache";
import type { CommandExecutor } from "./executor";
import { fetchHostSnapshot, stderrTail } from "./fetcher";

export interface RefreshDeps {
  /** Fresh config on every use; MUST throw on unreadable/invalid config. */
  loadConfig: () => AppConfig;
  store: SnapshotStore;
  executor: CommandExecutor;
  now?: () => Date;
  /** Injectable timers (tests). Defaults: setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string) => void;
}

export interface RefreshRun {
  /** True when this call actually started a refresh. */
  started: boolean;
  /** True when an in-flight refresh was joined instead. */
  alreadyRunning: boolean;
  /** Resolves when the (possibly joined) refresh completes. Never rejects. */
  promise: Promise<void>;
}

/** Retry cadence while the config file is transiently unreadable. */
const CONFIG_RETRY_MS = 60_000;

/** Floor for the wider-window refetch cooldown (minutes). */
const MIN_WIDER_COOLDOWN_MINUTES = 5;

export class RefreshManager {
  private inFlight: Promise<void> | null = null;
  private readonly fetching = new Set<string>();
  private timer: unknown = null;
  private schedulerActive = false;
  /**
   * Memory of the last wider-window refetch actually started, so a host
   * whose window can never widen (e.g. it is down and its degraded snapshot
   * keeps the old narrow window) cannot make every GET /api/usage start a
   * full all-host refresh forever. Cleared by any plain (manual/scheduled)
   * refresh.
   */
  private lastWider: { from: DateString; at: number } | null = null;

  private readonly now: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: RefreshDeps) {
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = deps.log ?? ((msg) => console.log(`[refresh] ${msg}`));
  }

  isRefreshing(): boolean {
    return this.inFlight !== null;
  }

  isHostRefreshing(hostId: string): boolean {
    return this.fetching.has(hostId);
  }

  /** Start a refresh, or join the in-flight one (single-flight). */
  refresh(opts?: { since?: DateString }): RefreshRun {
    if (this.inFlight !== null) {
      return { started: false, alreadyRunning: true, promise: this.inFlight };
    }
    // A plain refresh (manual button / scheduler tick) resets the wider-
    // window memory: the user explicitly asked for fresh data, so one
    // immediate wider retry is allowed again afterwards.
    if (opts?.since === undefined) this.lastWider = null;
    const promise = this.runRefresh(opts?.since).finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });
    this.inFlight = promise;
    return { started: true, alreadyRunning: false, promise };
  }

  /**
   * §3.2 exception: a request whose `from` predates the cached window kicks
   * a background refetch with a wider --since while the caller is served
   * from what the cache has. If a refresh is already in flight it is NOT
   * widened mid-run — the request is dropped; returns whether a refetch
   * started.
   *
   * Throttled: if a wider refetch for the same-or-earlier `from` already ran
   * within the cooldown (refresh interval, min 5 minutes), the request is a
   * no-op — otherwise a single down host (whose degraded snapshot preserves
   * its old narrow window) would turn every usage GET into a full all-host
   * SSH refresh, forever.
   */
  requestWiderWindow(from: DateString): boolean {
    if (this.inFlight !== null) return false;
    if (
      this.lastWider !== null &&
      this.lastWider.from <= from &&
      this.now().getTime() - this.lastWider.at < this.widerCooldownMs()
    ) {
      return false;
    }
    const run = this.refresh({ since: from });
    if (run.started) {
      this.lastWider = { from, at: this.now().getTime() };
      this.log(`wider-window refetch started (since ${from})`);
      void run.promise;
    }
    return run.started;
  }

  private widerCooldownMs(): number {
    let minutes = DEFAULT_REFRESH_INTERVAL_MINUTES;
    try {
      minutes =
        this.deps.loadConfig().refreshIntervalMinutes ??
        DEFAULT_REFRESH_INTERVAL_MINUTES;
    } catch {
      // keep the default while the config is unreadable
    }
    if (!Number.isFinite(minutes) || minutes <= 0) {
      minutes = DEFAULT_REFRESH_INTERVAL_MINUTES;
    }
    return Math.max(minutes, MIN_WIDER_COOLDOWN_MINUTES) * 60_000;
  }

  private async runRefresh(sinceOverride?: DateString): Promise<void> {
    let config: AppConfig;
    try {
      config = this.deps.loadConfig();
    } catch (err) {
      this.log(`refresh skipped — config unusable: ${String(err)}`);
      return;
    }
    const today = todayInTz(config.timezone, this.now());
    const defaultFrom = addDays(today, -config.fetchWindowDays);
    const from =
      sinceOverride !== undefined && compareDates(sinceOverride, defaultFrom) < 0
        ? sinceOverride
        : defaultFrom;
    const window = { from, to: today };

    const enabled = config.hosts.filter((h) => h.enabled);
    await Promise.all(
      enabled.map(async (host) => {
        this.fetching.add(host.id);
        try {
          const previous = this.deps.store.get(host.id);
          // Never NARROW a previously widened window: a snapshot fetched
          // with an older --since keeps that coverage on later scheduled
          // refreshes (otherwise every tick would discard the widened data
          // and the next old-range view would re-trigger a full wide
          // refetch — a permanent ping-pong).
          const hostWindow = {
            from: previous !== null ? minDate(window.from, previous.window.from) : window.from,
            to: window.to,
          };
          let snapshot: HostSnapshot;
          try {
            snapshot = await fetchHostSnapshot(host, {
              timezone: config.timezone,
              window: hostWindow,
              executor: this.deps.executor,
              now: this.now,
              previous,
            });
          } catch (err) {
            // fetchHostSnapshot never throws by contract; this is a
            // last-resort guard so one host can never take down the whole
            // refresh.
            this.log(`host ${host.id} refresh crashed: ${String(err)}`);
            const prev = this.deps.store.get(host.id);
            snapshot = prev
              ? {
                  ...prev,
                  error: {
                    kind: "unknown",
                    message: String(err),
                    exitCode: null,
                    stderrTail: stderrTail(String(err)),
                    at: this.now().toISOString(),
                  },
                }
              : {
                  hostId: host.id,
                  fetchedAt: this.now().toISOString(),
                  timezone: config.timezone,
                  window: hostWindow,
                  commands: [],
                  raw: { unified: null },
                  data: emptyHostUsageData(),
                  warnings: [],
                  error: {
                    kind: "unknown",
                    message: String(err),
                    exitCode: null,
                    stderrTail: stderrTail(String(err)),
                    at: this.now().toISOString(),
                  },
                };
          }
          // Persistence is NOT a host failure: save() updates the in-memory
          // map before writing, so an unwritable cache dir must only log —
          // never stamp a successful fetch with a per-host error.
          try {
            await this.deps.store.save(snapshot);
          } catch (err) {
            this.log(
              `snapshot persist failed for ${host.id} (data still served from memory): ${String(err)}`,
            );
          }
        } finally {
          this.fetching.delete(host.id);
        }
      }),
    );
  }

  /* -------------------- interval scheduler --------------------------- */

  /**
   * Schedule background refreshes every refreshIntervalMinutes (re-read from
   * config before each tick). No-op when already running. Auto-refresh is
   * disabled (nothing scheduled) when the interval is 0/absent/invalid.
   */
  startScheduler(): void {
    if (this.schedulerActive) return;
    this.schedulerActive = true;
    this.scheduleNext();
  }

  stopScheduler(): void {
    this.schedulerActive = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.schedulerActive) return;
    let intervalMinutes = 0;
    try {
      intervalMinutes = this.deps.loadConfig().refreshIntervalMinutes ?? 0;
    } catch (err) {
      // A transient config problem (hand edit mid-write, momentary bad
      // JSON) must NOT kill auto-refresh until restart: keep the scheduler
      // alive and retry. The retry only re-reads the config — it never
      // kicks a refresh, so a persistently broken config is not hammered.
      this.log(
        `config unusable (${String(err)}) — auto-refresh retrying in ${Math.round(CONFIG_RETRY_MS / 1000)}s`,
      );
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.scheduleNext();
      }, CONFIG_RETRY_MS);
      return;
    }
    if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
      this.log("auto-refresh disabled (refreshIntervalMinutes <= 0)");
      this.schedulerActive = false;
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = null;
      const run = this.refresh();
      void run.promise.finally(() => this.scheduleNext());
    }, intervalMinutes * 60_000);
  }
}
