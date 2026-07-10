/**
 * FR2 — eight KPI cards rendered verbatim from response.kpis. Total cost
 * is the hero (text-hero); every string comes from src/shared/format.ts.
 * Delta semantics per brief §1.3: more spend = red.
 */

import {
  formatCurrency,
  formatDateLabel,
  formatDelta,
  formatFullNumber,
  formatTokens,
} from "../../shared/format";
import type { KpiValue, UsageResponse } from "../../shared/types";
import { buildHarnessColorMap, harnessColor } from "../colors";
import { Dot } from "./Swatch";
import { Tip } from "./Tip";

type DeltaKind = "cost" | "neutral";

interface DeltaBadgeProps {
  kpi: KpiValue;
  kind: DeltaKind;
  periodLabel: string;
}

function DeltaBadge({ kpi, kind, periodLabel }: DeltaBadgeProps) {
  if (kpi.comparison === null) {
    if (kpi.comparisonUnavailableReason === "prior-period-not-covered") {
      return (
        <Tip
          content={`No comparison — the prior ${periodLabel} period isn't fully covered by the fetched data window.`}
        >
          <span className="flex items-center gap-1.5">
            <span className="badge badge-neutral" aria-label="comparison unavailable">
              —
            </span>
            <span className="t-caption" style={{ color: "var(--text-muted)" }}>
              vs prior {periodLabel}
            </span>
          </span>
        </Tip>
      );
    }
    return null;
  }

  const dp = kpi.comparison.deltaPercent;
  if (dp === null) {
    // Prior period existed but was $0 — "new" per brief §6.2.
    return (
      <span className="flex items-center gap-1.5">
        <span className="badge badge-neutral">new</span>
        <span className="t-caption" style={{ color: "var(--text-muted)" }}>
          vs prior {periodLabel}
        </span>
      </span>
    );
  }

  const glyph = dp > 0 ? "▲" : dp < 0 ? "▼" : "";
  let badgeClass = "badge badge-neutral";
  if (kind === "cost" && dp > 0) badgeClass = "badge badge-negative";
  if (kind === "cost" && dp < 0) badgeClass = "badge badge-positive";

  return (
    <span className="flex items-center gap-1.5">
      <span className={badgeClass}>
        {glyph && <span aria-hidden style={{ fontSize: 8 }}>{glyph}</span>}
        {formatDelta(dp)}
      </span>
      <span className="t-caption" style={{ color: "var(--text-muted)" }}>
        vs prior {periodLabel}
      </span>
    </span>
  );
}

interface KpiCardProps {
  label: string;
  children: React.ReactNode;
}

function KpiCard({ label, children }: KpiCardProps) {
  return (
    <div className="card flex flex-col gap-1" style={{ padding: 16, minHeight: 96 }}>
      <div className="t-label" style={{ color: "var(--text-secondary)" }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function EmDashValue() {
  return (
    <div className="t-kpi tabular" style={{ color: "var(--text-disabled)" }}>
      —
    </div>
  );
}

interface KpiGridProps {
  usage: UsageResponse;
  /** e.g. "30d" for presets, "31d" for a custom range of that length */
  periodLabel: string;
}

export function KpiGrid({ usage, periodLabel }: KpiGridProps) {
  const { kpis } = usage;
  const agentColors = buildHarnessColorMap(usage.availableAgents);

  return (
    <div className="kpi-grid">
      <KpiCard label="Total cost">
        <div className="t-hero tabular" data-testid="kpi-total-cost">
          {formatCurrency(kpis.totalCost.value)}
        </div>
        <DeltaBadge kpi={kpis.totalCost} kind="cost" periodLabel={periodLabel} />
      </KpiCard>

      <KpiCard label="Total tokens">
        <Tip content={`${formatFullNumber(kpis.totalTokens.value)} tokens`}>
          <div className="t-kpi tabular">{formatTokens(kpis.totalTokens.value)}</div>
        </Tip>
        <DeltaBadge kpi={kpis.totalTokens} kind="cost" periodLabel={periodLabel} />
      </KpiCard>

      <KpiCard label="Daily avg cost">
        <div className="t-kpi tabular">
          {formatCurrency(kpis.dailyAverageCost.value)}
        </div>
        <DeltaBadge kpi={kpis.dailyAverageCost} kind="cost" periodLabel={periodLabel} />
      </KpiCard>

      <KpiCard label="Active days">
        <div className="t-kpi tabular">
          {formatFullNumber(kpis.activeDays.value)}
          <span className="t-label" style={{ color: "var(--text-muted)", marginLeft: 4 }}>
            / {formatFullNumber(usage.dateAxis.length)}
          </span>
        </div>
        <DeltaBadge kpi={kpis.activeDays} kind="neutral" periodLabel={periodLabel} />
      </KpiCard>

      <KpiCard label="Projected month-end">
        {kpis.projectedMonthEnd !== null ? (
          <>
            <div className="t-kpi tabular">
              {formatCurrency(kpis.projectedMonthEnd.projectedCost)}
            </div>
            <div className="t-caption tabular" style={{ color: "var(--text-muted)" }}>
              naive linear projection · day {kpis.projectedMonthEnd.daysElapsed} of{" "}
              {kpis.projectedMonthEnd.daysInMonth}
            </div>
          </>
        ) : (
          <>
            <EmDashValue />
            <div className="t-caption" style={{ color: "var(--text-muted)" }}>
              no month-to-date usage
            </div>
          </>
        )}
      </KpiCard>

      <KpiCard label="Most expensive day">
        {kpis.mostExpensiveDay !== null ? (
          <>
            <div className="t-kpi tabular">
              {formatCurrency(kpis.mostExpensiveDay.cost)}
            </div>
            <div className="t-caption tabular" style={{ color: "var(--text-muted)" }}>
              {formatDateLabel(kpis.mostExpensiveDay.date)}
            </div>
          </>
        ) : (
          <>
            <EmDashValue />
            <div className="t-caption" style={{ color: "var(--text-muted)" }}>
              no usage in range
            </div>
          </>
        )}
      </KpiCard>

      <KpiCard label="Top model">
        {kpis.topModel !== null ? (
          <>
            <div
              className="t-body"
              style={{
                fontWeight: 600,
                color: "var(--text-primary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={kpis.topModel.model}
            >
              {kpis.topModel.model}
            </div>
            <div className="t-caption tabular" style={{ color: "var(--text-muted)" }}>
              {formatCurrency(kpis.topModel.cost)}
            </div>
          </>
        ) : (
          <>
            <EmDashValue />
            <div className="t-caption" style={{ color: "var(--text-muted)" }}>
              no model data in range
            </div>
          </>
        )}
      </KpiCard>

      <KpiCard label="Top harness">
        {kpis.topHarness !== null ? (
          <>
            <div
              className="t-body flex items-center gap-1.5"
              style={{ fontWeight: 600, color: "var(--text-primary)" }}
              title={kpis.topHarness.agent}
            >
              <Dot color={harnessColor(kpis.topHarness.agent, agentColors)} size={8} />
              {kpis.topHarness.agent}
            </div>
            <div className="t-caption tabular" style={{ color: "var(--text-muted)" }}>
              {formatCurrency(kpis.topHarness.cost)}
            </div>
          </>
        ) : (
          <>
            <EmDashValue />
            <div className="t-caption" style={{ color: "var(--text-muted)" }}>
              no usage in range
            </div>
          </>
        )}
      </KpiCard>
    </div>
  );
}
