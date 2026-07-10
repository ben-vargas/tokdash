/**
 * FR4 — sessions table (brief §6.5): top 100 by cost within the filter,
 * client-side text search over session id / project path via the shared
 * filterSessionRows, sortable, card-list collapse at ≤640px.
 */

import { useEffect, useMemo, useState } from "react";
import { filterSessionRows } from "../../shared/aggregate";
import { formatCurrency, formatRelativeTime, formatTokens } from "../../shared/format";
import type { HostRef, SessionTableRow } from "../../shared/types";
import { Dot } from "./Swatch";
import { TableScroll } from "./TableScroll";
import { Tip } from "./Tip";

type SortKey = "sessionId" | "agent" | "lastActivity" | "totalTokens" | "cost";

function middleTruncate(s: string, max = 18): string {
  if (s.length <= max) return s;
  // Codex path ids keep the tail (brief §6.5).
  if (s.includes("/")) {
    return `…${s.slice(-(max - 1))}`;
  }
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

function useIsNarrow(breakpoint: number): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(`(max-width: ${breakpoint}px)`).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [breakpoint]);
  return narrow;
}

interface SessionsTableProps {
  sessions: SessionTableRow[];
  hosts: readonly HostRef[];
  agentColors: ReadonlyMap<string, string>;
  now: Date;
}

export function SessionsTable({ sessions, hosts, agentColors, now }: SessionsTableProps) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "cost",
    dir: "desc",
  });
  const isCards = useIsNarrow(640);

  const hostById = new Map(hosts.map((h) => [h.id, h]));

  const filtered = useMemo(
    () => filterSessionRows(sessions, search),
    [sessions, search],
  );

  const sorted = useMemo(() => {
    const copy = [...filtered];
    const { key, dir } = sort;
    copy.sort((a, b) => {
      let cmp: number;
      if (key === "sessionId" || key === "agent") {
        cmp = a[key].localeCompare(b[key]);
      } else if (key === "lastActivity") {
        cmp = (a.lastActivity ?? "").localeCompare(b.lastActivity ?? "");
      } else {
        cmp = a[key] - b[key];
      }
      return dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sort]);

  const onSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" },
    );
  };

  const th = (label: string, key: SortKey | null, numeric = false) => {
    if (key === null) return <th className={numeric ? "num" : undefined}>{label}</th>;
    const active = sort.key === key;
    return (
      <th
        className={numeric ? "num" : undefined}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      >
        <button type="button" data-active={active} onClick={() => onSort(key)}>
          {label}
          {active && (
            <span aria-hidden style={{ fontSize: 8 }}>
              {sort.dir === "asc" ? "↑" : "↓"}
            </span>
          )}
        </button>
      </th>
    );
  };

  const hostCell = (row: SessionTableRow) => {
    const host = hostById.get(row.hostId);
    return (
      <span className="flex items-center gap-1.5 t-label" style={{ color: "var(--text-secondary)" }}>
        <Dot color={host?.color ?? "#8d867e"} />
        {host?.label ?? row.hostId}
      </span>
    );
  };

  const harnessCell = (row: SessionTableRow) => (
    <span className="flex items-center gap-1.5 t-label" style={{ color: "var(--text-secondary)" }}>
      <Dot color={agentColors.get(row.agent) ?? "#8a837a"} />
      {row.agent}
    </span>
  );

  const lastActivityCell = (row: SessionTableRow) =>
    row.lastActivity !== null ? (
      <span style={{ color: "var(--text-secondary)" }}>
        {formatRelativeTime(row.lastActivity, now)}
      </span>
    ) : (
      <Tip content="no session metadata for this harness">
        <span style={{ color: "var(--text-disabled)" }}>—</span>
      </Tip>
    );

  const modelsCell = (row: SessionTableRow) => {
    const firstModel = row.models[0];
    if (firstModel === undefined) {
      return <span style={{ color: "var(--text-disabled)" }}>—</span>;
    }
    return (
      <span className="flex items-center gap-1.5" title={row.models.join("\n")}>
        <span
          style={{
            maxWidth: 140,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--text-secondary)",
          }}
        >
          {firstModel}
        </span>
        {row.models.length > 1 && (
          <span className="badge badge-neutral">+{row.models.length - 1}</span>
        )}
      </span>
    );
  };

  const searchInput = (
    <div style={{ position: "relative", width: isCards ? "100%" : 240 }}>
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
        style={{
          position: "absolute",
          left: 8,
          top: "50%",
          transform: "translateY(-50%)",
          color: "var(--text-muted)",
        }}
      >
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.4" />
        <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <input
        type="search"
        className="field"
        style={{ height: 28, paddingLeft: 28, paddingRight: search ? 26 : 10 }}
        placeholder="Search session or project path…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        aria-label="Search sessions"
      />
      {search !== "" && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => setSearch("")}
          style={{
            position: "absolute",
            right: 6,
            top: "50%",
            transform: "translateY(-50%)",
            color: "var(--text-muted)",
            padding: 2,
          }}
        >
          ×
        </button>
      )}
    </div>
  );

  return (
    <section className="card" style={{ padding: 16 }} aria-label="Sessions">
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <div className="flex items-baseline gap-2">
          <h2 className="t-section" style={{ margin: 0 }}>
            Sessions
          </h2>
          <span className="t-caption tabular" style={{ color: "var(--text-muted)" }}>
            {search !== ""
              ? `${filtered.length} of ${sessions.length}`
              : `top ${sessions.length} by cost`}
          </span>
        </div>
        {searchInput}
      </div>

      {isCards ? (
        <div className="flex flex-col gap-2">
          {sorted.map((row) => {
            const host = hostById.get(row.hostId);
            return (
              <div
                key={`${row.hostId}:${row.sessionId}`}
                style={{
                  border: "1px solid var(--border-hairline)",
                  borderRadius: 8,
                  padding: 12,
                }}
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="t-mono" style={{ color: "var(--text-secondary)" }} title={row.sessionId}>
                    {middleTruncate(row.sessionId)}
                  </span>
                  <span className="tabular" style={{ fontWeight: 600 }}>
                    {formatCurrency(row.cost)}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 t-caption" style={{ color: "var(--text-secondary)" }}>
                  <span className="flex items-center gap-1">
                    <Dot color={host?.color ?? "#8d867e"} />
                    {host?.label ?? row.hostId}
                  </span>
                  <span aria-hidden>·</span>
                  <span className="flex items-center gap-1">
                    <Dot color={agentColors.get(row.agent) ?? "#8a837a"} />
                    {row.agent}
                  </span>
                  <span aria-hidden>·</span>
                  <span className="tabular">
                    {row.lastActivity !== null ? formatRelativeTime(row.lastActivity, now) : "—"}
                  </span>
                </div>
                <div className="mt-1 t-caption tabular" style={{ color: "var(--text-muted)" }}>
                  {formatTokens(row.totalTokens)} tokens
                  {row.models[0] !== undefined && <> · {row.models[0]}</>}
                </div>
              </div>
            );
          })}
          {sorted.length === 0 && (
            <div className="t-body py-4 text-center" style={{ color: "var(--text-muted)" }}>
              No sessions match.
              {search !== "" && (
                <span className="block t-caption pt-1">
                  Search matches session IDs and project paths — not host or harness names
                  (use the filter chips above for those).
                </span>
              )}
            </div>
          )}
        </div>
      ) : (
        <TableScroll>
          <table className="btable">
            <thead>
              <tr>
                {th("Session", "sessionId")}
                {th("Host", null)}
                {th("Harness", "agent")}
                {th("Models", null)}
                {th("Last activity", "lastActivity")}
                {th("Tokens", "totalTokens", true)}
                {th("Cost", "cost", true)}
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={`${row.hostId}:${row.sessionId}`}>
                  <td>
                    <span
                      className="t-mono block"
                      style={{ color: "var(--text-secondary)" }}
                      title={
                        row.projectPath !== null
                          ? `${row.sessionId}\n${row.projectPath}`
                          : row.sessionId
                      }
                    >
                      {middleTruncate(row.sessionId)}
                    </span>
                    {row.projectPath !== null && (
                      <span
                        className="block"
                        style={{
                          fontFamily: "var(--font-mono)",
                          fontSize: 11,
                          lineHeight: "14px",
                          color: "var(--text-muted)",
                          maxWidth: 220,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          direction: "rtl",
                          textAlign: "left",
                        }}
                        title={row.projectPath}
                      >
                        {row.projectPath}
                      </span>
                    )}
                  </td>
                  <td>{hostCell(row)}</td>
                  <td>{harnessCell(row)}</td>
                  <td>{modelsCell(row)}</td>
                  <td className="tabular">{lastActivityCell(row)}</td>
                  <td className="num" style={{ color: "var(--text-secondary)" }}>
                    {formatTokens(row.totalTokens)}
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {formatCurrency(row.cost)}
                  </td>
                </tr>
              ))}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ color: "var(--text-muted)" }}>
                    No sessions match.
                    {search !== "" && (
                      <span className="t-caption" style={{ marginLeft: 6 }}>
                        Search matches session IDs and project paths — not host or harness
                        names (use the filter chips above for those).
                      </span>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}
