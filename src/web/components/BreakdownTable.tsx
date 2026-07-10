/**
 * FR4 — sortable breakdown tables (brief §6.4): cost, 4 token classes,
 * share-of-total bar, sparkline aligned 1:1 with the response dateAxis.
 * Default sort cost desc; click cycles desc → asc; instant, no animation.
 */

import { useMemo, useState } from "react";
import {
  formatCurrency,
  formatDateLabel,
  formatFullNumber,
  formatPercent,
  formatTokens,
} from "../../shared/format";
import type { BreakdownRow, DateString } from "../../shared/types";
import { Swatch } from "./Swatch";
import { TableScroll } from "./TableScroll";

type SortKey =
  | "label"
  | "cost"
  | "share"
  | "totalTokens"
  | "inputTokens"
  | "outputTokens"
  | "cacheCreationTokens"
  | "cacheReadTokens";

interface SparklineProps {
  values: readonly number[];
  color: string;
  rangeLabel: string;
}

/** 96×20 inline polyline; flat-zero rows render a centered hairline. */
function Sparkline({ values, color, rangeLabel }: SparklineProps) {
  const W = 96;
  const H = 20;
  const max = values.reduce((m, v) => (v > m ? v : m), 0);
  let content: React.ReactNode;
  if (max <= 0 || values.length < 2) {
    content = (
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="var(--border-hairline)" strokeWidth={1} />
    );
  } else {
    const pts = values
      .map((v, i) => {
        const x = (i / (values.length - 1)) * W;
        const y = H - 1.5 - (v / max) * (H - 3);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    content = (
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.25}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    );
  }
  return (
    <svg
      width={W}
      height={H}
      role="img"
      aria-label={rangeLabel}
      style={{ display: "block" }}
    >
      <title>{rangeLabel}</title>
      {content}
    </svg>
  );
}

function ShareBar({ share, color }: { share: number; color: string }) {
  return (
    <span className="flex items-center justify-end gap-2">
      <span
        aria-hidden
        style={{
          width: 48,
          height: 4,
          borderRadius: 2,
          background: "var(--surface-inset)",
          overflow: "hidden",
          display: "inline-block",
        }}
      >
        <span
          style={{
            display: "block",
            width: `${Math.min(100, share * 100)}%`,
            height: "100%",
            background: color,
            borderRadius: 2,
          }}
        />
      </span>
      <span className="tabular" style={{ color: "var(--text-secondary)", minWidth: 42 }}>
        {formatPercent(share)}
      </span>
    </span>
  );
}

interface HeaderCellProps {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  dir: "asc" | "desc";
  numeric?: boolean;
  /** Token-class detail columns hide when the card is narrow (§8.7). */
  detail?: boolean;
  onSort: (key: SortKey) => void;
}

function HeaderCell({ label, sortKey, active, dir, numeric, detail, onSort }: HeaderCellProps) {
  const isActive = active === sortKey;
  const cls = [numeric === true ? "num" : "", detail === true ? "col-detail" : ""]
    .filter((s) => s !== "")
    .join(" ");
  return (
    <th className={cls === "" ? undefined : cls} aria-sort={isActive ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" data-active={isActive} onClick={() => onSort(sortKey)}>
        {label}
        {isActive && (
          <span aria-hidden style={{ fontSize: 8 }}>
            {dir === "asc" ? "↑" : "↓"}
          </span>
        )}
      </button>
    </th>
  );
}

interface BreakdownTableProps {
  title: string;
  rows: BreakdownRow[];
  /** row key → identity color */
  colorOf: (row: BreakdownRow) => string;
  dateAxis: readonly DateString[];
  /** Collapse rows beyond this count behind a "show all" expander. */
  maxRows?: number;
}

export function BreakdownTable({ title, rows, colorOf, dateAxis, maxRows }: BreakdownTableProps) {
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "cost",
    dir: "desc",
  });
  const [expanded, setExpanded] = useState(false);

  const onSort = (key: SortKey) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" },
    );
  };

  const sorted = useMemo(() => {
    const copy = [...rows];
    const { key, dir } = sort;
    copy.sort((a, b) => {
      const cmp =
        key === "label"
          ? a.label.localeCompare(b.label)
          : (a[key] as number) - (b[key] as number);
      return dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sort]);

  // Long-tail collapse (By model has ~30 rows of $0.0x noise): show the
  // top `maxRows` in the current sort order behind an expander.
  const collapsible = maxRows !== undefined && rows.length > maxRows + 1;
  const visible = collapsible && !expanded ? sorted.slice(0, maxRows) : sorted;
  const hiddenCount = sorted.length - visible.length;

  const first = dateAxis[0];
  const last = dateAxis[dateAxis.length - 1];
  const rangeLabel =
    first !== undefined && last !== undefined
      ? `daily cost, ${formatDateLabel(first)} – ${formatDateLabel(last)}`
      : "daily cost";

  return (
    <section className="card bd-card" style={{ padding: 16 }} aria-label={title}>
      <div className="flex items-baseline justify-between pb-3">
        <h2 className="t-section" style={{ margin: 0 }}>
          {title}
        </h2>
        <span className="t-caption tabular" style={{ color: "var(--text-muted)" }}>
          {rows.length} {rows.length === 1 ? "row" : "rows"}
        </span>
      </div>
      <TableScroll>
        <table className="btable">
          <thead>
            <tr>
              <HeaderCell label={title.replace(/^By /, "")} sortKey="label" active={sort.key} dir={sort.dir} onSort={onSort} />
              <HeaderCell label="Cost" sortKey="cost" active={sort.key} dir={sort.dir} numeric onSort={onSort} />
              <HeaderCell label="Share" sortKey="share" active={sort.key} dir={sort.dir} numeric onSort={onSort} />
              <HeaderCell label="Tokens" sortKey="totalTokens" active={sort.key} dir={sort.dir} numeric onSort={onSort} />
              <HeaderCell label="In" sortKey="inputTokens" active={sort.key} dir={sort.dir} numeric detail onSort={onSort} />
              <HeaderCell label="Out" sortKey="outputTokens" active={sort.key} dir={sort.dir} numeric detail onSort={onSort} />
              <HeaderCell label="Cache W" sortKey="cacheCreationTokens" active={sort.key} dir={sort.dir} numeric detail onSort={onSort} />
              <HeaderCell label="Cache R" sortKey="cacheReadTokens" active={sort.key} dir={sort.dir} numeric detail onSort={onSort} />
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const color = colorOf(row);
              return (
                <tr key={row.key}>
                  <td>
                    <span className="flex items-center" title={row.label}>
                      <Swatch color={color} />
                      <span
                        style={{
                          maxWidth: 160,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {row.label}
                      </span>
                    </span>
                  </td>
                  <td className="num" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                    {formatCurrency(row.cost)}
                  </td>
                  <td className="num">
                    <ShareBar share={row.share} color={color} />
                  </td>
                  <td className="num" style={{ color: "var(--text-secondary)" }}>
                    {formatTokens(row.totalTokens)}
                  </td>
                  <td className="num col-detail" style={{ color: "var(--text-secondary)" }}>
                    {formatTokens(row.inputTokens)}
                  </td>
                  <td className="num col-detail" style={{ color: "var(--text-secondary)" }}>
                    {formatTokens(row.outputTokens)}
                  </td>
                  <td className="num col-detail" style={{ color: "var(--text-secondary)" }}>
                    {formatTokens(row.cacheCreationTokens)}
                  </td>
                  <td className="num col-detail" style={{ color: "var(--text-secondary)" }}>
                    {formatTokens(row.cacheReadTokens)}
                  </td>
                  <td>
                    <Sparkline values={row.sparkline} color={color} rangeLabel={rangeLabel} />
                  </td>
                </tr>
              );
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={9} style={{ color: "var(--text-muted)" }}>
                  No rows in the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </TableScroll>
      {collapsible && (
        <div className="pt-2">
          <button
            type="button"
            className="btn-ghost t-caption"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded
              ? "Show fewer"
              : `Show all ${formatFullNumber(sorted.length)} rows (${formatFullNumber(hiddenCount)} more)`}
          </button>
        </div>
      )}
    </section>
  );
}
