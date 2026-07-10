/**
 * Header (brief §4.2/§6.9): app name left; right cluster = per-host
 * freshness dots, refresh button with relative age, theme toggle,
 * settings gear. 56px tall, hairline bottom border, not sticky.
 */

import type { HostStatus, StatusResponse } from "../../shared/types";
import { formatRelativeTime } from "../../shared/format";
import { Tip } from "./Tip";
import type { Theme } from "../hooks/useTheme";

const FRESHNESS_COLOR: Record<HostStatus["freshness"], string> = {
  fresh: "var(--positive)",
  stale: "var(--warning)",
  error: "var(--negative)",
  never: "var(--text-disabled)",
};

function freshnessTip(h: HostStatus, now: Date): string {
  const age =
    h.fetchedAt !== null ? formatRelativeTime(h.fetchedAt, now) : "never";
  switch (h.freshness) {
    case "fresh":
      return `${h.label} · fresh · refreshed ${age}`;
    case "stale":
      return `${h.label} · stale · refreshed ${age}`;
    case "error":
      return `${h.label} · error: ${h.error?.message ?? "unknown"}${
        h.fetchedAt !== null ? ` (showing cached data from ${age})` : ""
      }`;
    case "never":
      return `${h.label} · no data fetched yet`;
  }
}

function HostFreshnessDot({ h, now }: { h: HostStatus; now: Date }) {
  return (
    // The header is 56px tall — tooltips must open downward or they clip
    // off the top of the viewport (brief §6.7/§6.9).
    <Tip content={freshnessTip(h, now)} placement="below">
      <span
        aria-label={freshnessTip(h, now)}
        style={{ position: "relative", display: "inline-flex", padding: 2 }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: h.color,
            opacity: h.enabled ? 1 : 0.4,
          }}
        />
        <span
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: 6,
            height: 6,
            borderRadius: 999,
            background: FRESHNESS_COLOR[h.freshness],
            border: "1px solid var(--bg)",
          }}
        />
      </span>
    </Tip>
  );
}

const WORST_ORDER: HostStatus["freshness"][] = ["error", "never", "stale", "fresh"];

interface HeaderProps {
  status: StatusResponse | undefined;
  theme: Theme;
  onToggleTheme: () => void;
  onRefresh: () => void;
  refreshStarting: boolean;
  onOpenSettings: () => void;
  now: Date;
}

export function Header({
  status,
  theme,
  onToggleTheme,
  onRefresh,
  refreshStarting,
  onOpenSettings,
  now,
}: HeaderProps) {
  const refreshing = status?.refreshing === true || refreshStarting;
  const hosts = status?.hosts ?? [];
  const newestFetch = hosts.reduce<string | null>(
    (acc, h) =>
      h.fetchedAt !== null && (acc === null || h.fetchedAt > acc)
        ? h.fetchedAt
        : acc,
    null,
  );
  const worst =
    hosts.length > 0
      ? WORST_ORDER.find((f) => hosts.some((h) => h.enabled && h.freshness === f)) ?? "never"
      : "never";

  return (
    <header
      className="w-full"
      style={{
        height: 56,
        borderBottom: "1px solid var(--border-hairline)",
        background: "var(--bg)",
      }}
    >
      <div className="page flex h-full items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h1 className="t-title" style={{ margin: 0 }}>
            TokDash
          </h1>
          <span className="t-caption" style={{ color: "var(--text-muted)" }}>
            multi-host ccusage
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Per-host freshness: full cluster ≥768px, worst-dot summary below */}
          <div className="hidden items-center gap-1.5 md:flex" style={{ marginRight: 4 }}>
            {hosts.map((h) => (
              <HostFreshnessDot key={h.hostId} h={h} now={now} />
            ))}
          </div>
          {hosts.length > 0 && (
            <div className="flex md:hidden">
              <Tip
                content={`${hosts.length} hosts · worst status: ${worst}`}
                align="left"
                placement="below"
              >
                <span className="flex items-center gap-1.5 px-1">
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      background: FRESHNESS_COLOR[worst],
                    }}
                  />
                  <span className="t-caption tabular" style={{ color: "var(--text-muted)" }}>
                    {hosts.length} hosts
                  </span>
                </span>
              </Tip>
            </div>
          )}

          <button
            type="button"
            className="btn-ghost"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label={refreshing ? "Refreshing…" : "Refresh usage data"}
            title={refreshing ? "Refresh in progress" : "Refresh usage data"}
          >
            <svg
              className={refreshing ? "spin" : ""}
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden
              style={{ color: refreshing ? "var(--accent)" : "currentColor" }}
            >
              <path
                d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89M13.5 1.5v3h-3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span
              className="t-caption tabular hidden md:inline"
              style={{ color: "var(--text-muted)" }}
            >
              {refreshing
                ? "Refreshing…"
                : newestFetch !== null
                  ? formatRelativeTime(newestFetch, now)
                  : "never"}
            </span>
          </button>

          <button
            type="button"
            className="btn-ghost"
            onClick={onToggleTheme}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {theme === "dark" ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <circle cx="8" cy="8" r="3.25" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.95 3.05l-1.06 1.06M4.11 11.89l-1.06 1.06M12.95 12.95l-1.06-1.06M4.11 4.11 3.05 3.05"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7Z"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>

          <button
            type="button"
            className="btn-ghost"
            onClick={onOpenSettings}
            aria-label="Open settings"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
              <circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M13.3 10.2a1.2 1.2 0 0 0 .24 1.32l.04.05a1.45 1.45 0 1 1-2.05 2.05l-.05-.04a1.2 1.2 0 0 0-1.32-.24 1.2 1.2 0 0 0-.73 1.1v.12a1.45 1.45 0 0 1-2.9 0v-.06a1.2 1.2 0 0 0-.78-1.1 1.2 1.2 0 0 0-1.32.24l-.05.04a1.45 1.45 0 1 1-2.05-2.05l.04-.05a1.2 1.2 0 0 0 .24-1.32 1.2 1.2 0 0 0-1.1-.73h-.12a1.45 1.45 0 0 1 0-2.9h.06a1.2 1.2 0 0 0 1.1-.78 1.2 1.2 0 0 0-.24-1.32l-.04-.05A1.45 1.45 0 1 1 4.3 2.65l.05.04a1.2 1.2 0 0 0 1.32.24h.06a1.2 1.2 0 0 0 .72-1.1v-.12a1.45 1.45 0 0 1 2.9 0v.06a1.2 1.2 0 0 0 .73 1.1 1.2 1.2 0 0 0 1.32-.24l.05-.04a1.45 1.45 0 1 1 2.05 2.05l-.04.05a1.2 1.2 0 0 0-.24 1.32v.06a1.2 1.2 0 0 0 1.1.72h.12a1.45 1.45 0 0 1 0 2.9h-.06a1.2 1.2 0 0 0-1.1.73Z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
