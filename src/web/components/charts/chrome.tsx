/**
 * Shared chart chrome (brief §6.3): card wrapper with title/controls
 * header and top legend; axis defaults; the custom tooltip card. All
 * three charts consume these so their chrome is identical.
 */

import type { ReactNode } from "react";
import type { XAxisProps, YAxisProps } from "recharts";
import { formatDateLabel, formatTokens } from "../../../shared/format";
import type { DateString } from "../../../shared/types";
import { LineSwatch, Swatch } from "../Swatch";

/* ---------------------------------------------------------------- */
/* Axis defaults                                                     */
/* ---------------------------------------------------------------- */

export const CHART_MARGIN = { top: 8, right: 8, bottom: 0, left: 0 } as const;

export function xAxisProps(): Partial<XAxisProps> {
  return {
    axisLine: false,
    tickLine: false,
    tick: { fontSize: 11, fill: "var(--chart-axis)" },
    tickFormatter: (v: string) => formatDateLabel(v),
    interval: "preserveStartEnd",
    minTickGap: 28,
  };
}

export function yAxisProps(kind: "cost" | "tokens"): Partial<YAxisProps> {
  return {
    axisLine: false,
    tickLine: false,
    tick: { fontSize: 11, fill: "var(--chart-axis)" },
    tickFormatter:
      kind === "cost"
        ? (v: number) => formatCostAxisTick(v)
        : (v: number) => formatTokens(v),
    width: kind === "cost" ? 46 : 44,
  };
}

/**
 * Compact cost tick ("$1.2k") — axis-only format mandated by brief §6.3.
 * Deliberate deviation from the format.ts-only rule: format.ts has no
 * compact-currency function and full "$1,234.56" ticks don't fit an
 * axis. Tooltips and KPIs still use formatCurrency exclusively.
 */
export function formatCostAxisTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) {
    const k = value / 1000;
    return `$${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  if (abs >= 10 || Number.isInteger(value)) return `$${Math.round(value)}`;
  return `$${value}`;
}

/* ---------------------------------------------------------------- */
/* Card wrapper + legend                                             */
/* ---------------------------------------------------------------- */

export interface LegendItem {
  id: string;
  label: string;
  color: string;
  /** true → 10×2 line swatch instead of the 8×8 square */
  line?: boolean;
  /** true → hatched preview (no-model-data bands) */
  hatched?: boolean;
}

export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <div className="flex flex-wrap items-center" style={{ gap: "4px 14px" }}>
      {items.map((item) => (
        <span
          key={item.id}
          className="t-label flex items-center"
          style={{ color: "var(--text-secondary)" }}
          title={item.label}
        >
          {item.line === true ? (
            <LineSwatch color={item.color} />
          ) : item.hatched === true ? (
            <span
              aria-hidden
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: 2,
                marginRight: 6,
                background: `repeating-linear-gradient(45deg, ${item.color} 0 2px, transparent 2px 4px)`,
                opacity: 0.7,
                flex: "none",
              }}
            />
          ) : (
            <Swatch color={item.color} />
          )}
          <span
            style={{
              maxWidth: 180,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.label}
          </span>
        </span>
      ))}
    </div>
  );
}

interface ChartCardProps {
  title: string;
  ariaLabel: string;
  controls?: ReactNode;
  badge?: ReactNode;
  legend?: LegendItem[];
  caption?: string;
  height: number;
  children: ReactNode;
}

export function ChartCard({
  title,
  ariaLabel,
  controls,
  badge,
  legend,
  caption,
  height,
  children,
}: ChartCardProps) {
  return (
    <section
      className="card flex flex-col gap-3"
      style={{ padding: 16 }}
      aria-label={ariaLabel}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="t-section" style={{ margin: 0 }}>
            {title}
          </h2>
          {badge}
        </div>
        {controls}
      </div>
      {legend !== undefined && legend.length > 0 && <ChartLegend items={legend} />}
      <div style={{ width: "100%", height }} role="img" aria-label={ariaLabel}>
        {children}
      </div>
      {caption !== undefined && (
        <div className="t-caption" style={{ color: "var(--text-muted)" }}>
          {caption}
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- */
/* Tooltip card                                                      */
/* ---------------------------------------------------------------- */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function tooltipDateHeader(date: DateString): string {
  // Weekday from the calendar date itself (UTC parse — no tz drift).
  const d = new Date(`${date}T00:00:00Z`);
  const weekday = Number.isNaN(d.getTime())
    ? null
    : WEEKDAYS[d.getUTCDay()] ?? null;
  const label = formatDateLabel(date);
  return weekday !== null ? `${weekday} · ${label}` : label;
}

export interface TooltipRow {
  id: string;
  label: string;
  color: string;
  value: number;
}

interface ChartTooltipCardProps {
  header: string;
  rows: TooltipRow[];
  formatValue: (value: number) => string;
  total?: { label: string; text: string } | undefined;
}

/**
 * The §6.3 tooltip card: rows sorted by value desc, zero rows omitted,
 * swatch + truncated label left, tabular value right, optional total
 * row above a hairline.
 */
export function ChartTooltipCard({
  header,
  rows,
  formatValue,
  total,
}: ChartTooltipCardProps) {
  const visible = rows.filter((r) => r.value !== 0).sort((a, b) => b.value - a.value);
  return (
    <div
      className="floating"
      style={{ borderRadius: 8, padding: "10px 12px", minWidth: 180 }}
    >
      <div className="t-label tabular" style={{ fontWeight: 600, color: "var(--text-primary)" }}>
        {header}
      </div>
      <div className="mt-1.5 flex flex-col gap-1">
        {visible.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-4">
            <span className="t-label flex min-w-0 items-center" style={{ color: "var(--text-secondary)" }}>
              <Swatch color={r.color} />
              <span
                style={{
                  maxWidth: "24ch",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.label}
              </span>
            </span>
            <span className="t-label tabular" style={{ color: "var(--text-primary)" }}>
              {formatValue(r.value)}
            </span>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="t-label" style={{ color: "var(--text-muted)" }}>
            no usage
          </div>
        )}
      </div>
      {total !== undefined && (
        <div
          className="mt-1.5 flex items-center justify-between gap-4 pt-1.5"
          style={{ borderTop: "1px solid var(--border-hairline)" }}
        >
          <span className="t-label" style={{ fontWeight: 600, color: "var(--text-secondary)" }}>
            {total.label}
          </span>
          <span className="t-label tabular" style={{ fontWeight: 600, color: "var(--text-primary)" }}>
            {total.text}
          </span>
        </div>
      )}
    </div>
  );
}
