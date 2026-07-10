/**
 * UsageResponse.warnings can hold hundreds of entries (metadata-less
 * sessions). They are collapsed into one warning pill — never toasted
 * individually — and the expanded panel groups per-session warnings by
 * kind ("688 sessions on local have no attributable date…") with the
 * individual session ids behind a "show sessions" affordance.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { formatFullNumber } from "../../shared/format";

const MAX_GROUPS_SHOWN = 12;

/**
 * Per-session warnings from the aggregation layer follow the template
 *   Session "<id>" (<context>) <rest>
 * e.g. `Session "0012…" (host "local") has no attributable date; …`.
 * Everything after the session id is the "kind"; identical kinds are
 * grouped with a count and their session ids collected.
 */
const SESSION_WARNING_RE = /^Session "([^"]+)" \(([^)]*)\) (.+)$/;

interface WarningGroup {
  /** Grouped display message (already pluralized when count > 1). */
  message: string;
  count: number;
  /** Session ids behind the group; empty for non-session warnings. */
  sessionIds: string[];
}

export function groupWarnings(warnings: readonly string[]): WarningGroup[] {
  const groups = new Map<string, WarningGroup & { context: string; rest: string }>();
  for (const w of warnings) {
    const m = SESSION_WARNING_RE.exec(w);
    if (m !== null) {
      const [, sessionId, context, rest] = m as unknown as [string, string, string, string];
      const key = `s|${context}|${rest}`;
      const g = groups.get(key);
      if (g !== undefined) {
        g.count += 1;
        g.sessionIds.push(sessionId);
      } else {
        groups.set(key, { message: w, count: 1, sessionIds: [sessionId], context, rest });
      }
    } else {
      const key = `p|${w}`;
      const g = groups.get(key);
      if (g !== undefined) g.count += 1;
      else groups.set(key, { message: w, count: 1, sessionIds: [], context: "", rest: "" });
    }
  }
  return [...groups.values()]
    .map((g) => ({
      message:
        g.count > 1 && g.sessionIds.length > 0
          ? // "688 sessions (host "local") has no…" → plural verb.
            `${formatFullNumber(g.count)} sessions (${g.context}) ${g.rest.replace(/^has /, "have ")}`
          : g.message,
      count: g.count,
      sessionIds: g.sessionIds,
    }))
    .sort((a, b) => b.count - a.count);
}

function GroupRow({ group }: { group: WarningGroup }) {
  const [showIds, setShowIds] = useState(false);
  return (
    <div className="t-label flex items-start gap-2" style={{ color: "var(--text-secondary)" }}>
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: "var(--warning)",
          marginTop: 5,
          flex: "none",
        }}
      />
      <span style={{ overflowWrap: "anywhere", minWidth: 0, flex: 1 }}>
        {group.message}
        {group.count > 1 && group.sessionIds.length === 0 && (
          <span className="tabular" style={{ color: "var(--text-muted)" }}>
            {" "}
            ×{formatFullNumber(group.count)}
          </span>
        )}
        {group.count > 1 && group.sessionIds.length > 0 && (
          <>
            {" "}
            <button
              type="button"
              className="t-caption"
              aria-expanded={showIds}
              onClick={() => setShowIds((v) => !v)}
              style={{ color: "var(--accent)", padding: 0 }}
            >
              {showIds ? "hide sessions" : "show sessions"}
            </button>
            {showIds && (
              <span
                className="t-mono inset-well block"
                style={{
                  marginTop: 4,
                  padding: "4px 8px",
                  fontSize: 11,
                  lineHeight: "15px",
                  maxHeight: 96,
                  overflowY: "auto",
                  color: "var(--text-muted)",
                }}
              >
                {group.sessionIds.map((id) => (
                  <span key={id} className="block" style={{ overflowWrap: "anywhere" }}>
                    {id}
                  </span>
                ))}
              </span>
            )}
          </>
        )}
      </span>
    </div>
  );
}

export function WarningsPill({ warnings }: { warnings: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupWarnings(warnings), [warnings]);

  // Same dismissal affordances as the custom-range popover (FilterBar):
  // Escape and clicking outside close the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      if (
        containerRef.current !== null &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [open]);

  if (warnings.length === 0) return null;

  return (
    <div ref={containerRef} style={{ position: "relative", alignSelf: "flex-start" }}>
      <button
        type="button"
        className="badge badge-warning"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: "pointer" }}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path
            d="M8 2 1.5 13.5h13L8 2Z"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
          <path d="M8 6.5V10M8 11.5v.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
        {/* Headline counts warning KINDS (the grouped rows the popover
            shows), not raw per-session entries — "706 data warnings" for 3
            benign groups is alarm-fatigue, not information. */}
        {formatFullNumber(groups.length)} data {groups.length === 1 ? "warning" : "warnings"}
      </button>
      {open && (
        <div
          className="floating"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            zIndex: 40,
            width: 420,
            maxWidth: "calc(100vw - 48px)",
            maxHeight: 260,
            overflowY: "auto",
            padding: 12,
          }}
          role="region"
          aria-label="Data warnings"
        >
          <div className="flex flex-col gap-2">
            {groups.slice(0, MAX_GROUPS_SHOWN).map((g) => (
              <GroupRow key={g.message} group={g} />
            ))}
            {groups.length > MAX_GROUPS_SHOWN && (
              <div className="t-caption" style={{ color: "var(--text-muted)" }}>
                +{formatFullNumber(groups.length - MAX_GROUPS_SHOWN)} more warning kinds
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
