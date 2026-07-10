/**
 * FR1 — always-visible sticky filter bar (brief §6.1): date-preset
 * segmented control + custom range popover, host chips (with per-host
 * cost for the active range), harness chips. All state lives in the URL.
 */

import { useEffect, useRef, useState } from "react";
import { DATE_PRESETS } from "../../shared/constants";
import { isValidDateString } from "../../shared/dates";
import { formatCurrency, formatDateLabel } from "../../shared/format";
import type {
  DatePreset,
  DateRange,
  UsageResponse,
} from "../../shared/types";
import type { FilterState } from "../hooks/useFilters";
import { buildHarnessColorMap, harnessColor } from "../colors";
import { Tip } from "./Tip";

const PRESET_LABELS: Record<DatePreset, string> = {
  today: "Today",
  "7d": "7d",
  "14d": "14d",
  "30d": "30d",
  "60d": "60d",
  "90d": "90d",
  mtd: "MTD",
};

interface CustomRangePopoverProps {
  range: DateRange;
  onApply: (range: DateRange) => void;
  onClose: () => void;
}

function CustomRangePopover({ range, onApply, onClose }: CustomRangePopoverProps) {
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const ref = useRef<HTMLDivElement>(null);

  const valid =
    isValidDateString(from) && isValidDateString(to) && from <= to;
  const orderError =
    isValidDateString(from) && isValidDateString(to) && from > to;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="floating absolute mt-1 p-3"
      style={{
        zIndex: 50,
        width: "min(420px, calc(100vw - 32px))",
        borderRadius: "var(--radius-card)",
      }}
      role="dialog"
      aria-label="Custom date range"
    >
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 150px), 1fr))",
        }}
      >
        <label style={{ minWidth: 0 }}>
          <span className="t-label block pb-1" style={{ color: "var(--text-secondary)" }}>
            From
          </span>
          <input
            type="date"
            className="field tabular"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            style={{ minWidth: 0, maxWidth: "100%" }}
          />
        </label>
        <label style={{ minWidth: 0 }}>
          <span className="t-label block pb-1" style={{ color: "var(--text-secondary)" }}>
            To
          </span>
          <input
            type="date"
            className="field tabular"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
            style={{ minWidth: 0, maxWidth: "100%" }}
          />
        </label>
      </div>
      {orderError && (
        <div className="t-caption pt-2" style={{ color: "var(--negative)" }}>
          "From" must be on or before "To".
        </div>
      )}
      <div className="flex justify-end gap-2 pt-3">
        <button type="button" className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={!valid}
          onClick={() => {
            if (valid) onApply({ from, to });
          }}
        >
          Apply
        </button>
      </div>
    </div>
  );
}

interface FilterBarProps {
  filters: FilterState;
  activeRange: DateRange;
  usage: UsageResponse | undefined;
  onPreset: (preset: DatePreset) => void;
  onCustomRange: (range: DateRange) => void;
  onToggleHost: (id: string, allIds: readonly string[]) => void;
  onToggleAgent: (id: string, allIds: readonly string[]) => void;
}

export function FilterBar({
  filters,
  activeRange,
  usage,
  onPreset,
  onCustomRange,
  onToggleHost,
  onToggleAgent,
}: FilterBarProps) {
  const [customOpen, setCustomOpen] = useState(false);

  const hosts = usage?.availableHosts ?? [];
  const agents = usage?.availableAgents ?? [];
  const enabledHostIds = hosts.filter((h) => h.enabled).map((h) => h.id);
  const agentColors = buildHarnessColorMap(agents);

  const activeHosts = new Set(filters.hosts ?? enabledHostIds);
  const activeAgents = new Set(filters.agents ?? agents);

  const costByHost = new Map<string, number>(
    (usage?.tables.byHost ?? []).map((r) => [r.key, r.cost]),
  );

  return (
    <div className="filter-bar">
      <div className="page flex flex-wrap items-center gap-3" style={{ padding: "10px 24px" }}>
        {/* Date presets */}
        <div className="scroll-row" style={{ gap: 8 }}>
          <div className="seg" role="group" aria-label="Date range preset">
            {DATE_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className="seg-btn tabular"
                aria-pressed={filters.preset === p}
                onClick={() => onPreset(p)}
              >
                {PRESET_LABELS[p]}
              </button>
            ))}
          </div>

          <div style={{ position: "relative" }}>
            <button
              type="button"
              className="btn-ghost tabular"
              aria-expanded={customOpen}
              aria-haspopup="dialog"
              onClick={() => setCustomOpen((v) => !v)}
              style={
                filters.preset === null
                  ? { color: "var(--text-primary)", background: "var(--surface-hover)" }
                  : undefined
              }
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
                <rect x="2" y="3" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
              {filters.preset === null
                ? `${formatDateLabel(activeRange.from)} – ${formatDateLabel(activeRange.to)}`
                : "Custom…"}
            </button>
            {customOpen && (
              <CustomRangePopover
                range={activeRange}
                onApply={(r) => {
                  onCustomRange(r);
                  setCustomOpen(false);
                }}
                onClose={() => setCustomOpen(false)}
              />
            )}
          </div>
        </div>

        <div className="vdivider" aria-hidden />

        {/* Host chips */}
        <div className="scroll-row" role="group" aria-label="Host filter">
          {hosts.map((h) => {
            const included = activeHosts.has(h.id);
            const cost = costByHost.get(h.id) ?? 0;
            if (!h.enabled) {
              return (
                <Tip key={h.id} content="disabled in settings">
                  <button
                    type="button"
                    className="chip"
                    disabled
                    aria-pressed={false}
                    style={{ ["--chip" as string]: h.color }}
                  >
                    <span className="chip-dot" />
                    {h.label}
                  </button>
                </Tip>
              );
            }
            return (
              <button
                key={h.id}
                type="button"
                className="chip"
                aria-pressed={included}
                onClick={() => onToggleHost(h.id, enabledHostIds)}
                style={{ ["--chip" as string]: h.color }}
                title={included ? `Exclude ${h.label}` : `Include ${h.label}`}
              >
                <span className="chip-dot" />
                {h.label}
                {included && (
                  <span className="chip-cost">· {formatCurrency(cost)}</span>
                )}
              </button>
            );
          })}
        </div>

        {agents.length > 0 && <div className="vdivider" aria-hidden />}

        {/* Harness chips */}
        <div className="scroll-row" role="group" aria-label="Harness filter">
          {agents.map((a) => {
            const included = activeAgents.has(a);
            return (
              <button
                key={a}
                type="button"
                className="chip"
                aria-pressed={included}
                onClick={() => onToggleAgent(a, agents)}
                style={{ ["--chip" as string]: harnessColor(a, agentColors) }}
                title={included ? `Exclude ${a}` : `Include ${a}`}
              >
                <span className="chip-dot" />
                {a}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
