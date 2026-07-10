/**
 * TokDash — application shell. Layout per brief §4.2: header, sticky
 * filter bar, KPI row, daily-cost chart, 2-up charts, breakdown tables,
 * sessions. The /api/usage response is the single source of truth; the
 * browser never re-aggregates.
 */

import { useEffect, useMemo, useState } from "react";
import { todayInTz } from "../shared/dates";
import type { BreakdownRow, UsageResponse } from "../shared/types";
import type { UsageParams } from "./api";
import {
  buildHarnessColorMap,
  buildHostColorMap,
  harnessColor,
  MODEL_RAMP,
  OTHER_MODEL_COLOR,
  OTHER_MODELS_KEY,
} from "./colors";
import { BreakdownTable } from "./components/BreakdownTable";
import { CumulativeChart } from "./components/charts/CumulativeChart";
import { DailyCostChart } from "./components/charts/DailyCostChart";
import { TokenCompositionChart } from "./components/charts/TokenCompositionChart";
import { EmptyState } from "./components/EmptyState";
import { FilterBar } from "./components/FilterBar";
import { Header } from "./components/Header";
import { KpiGrid } from "./components/KpiGrid";
import { Onboarding } from "./components/Onboarding";
import { SessionsTable } from "./components/SessionsTable";
import { SettingsDialog } from "./components/SettingsDialog";
import { PageSkeleton } from "./components/Skeletons";
import { Toasts } from "./components/Toasts";
import { WarningsPill } from "./components/WarningsPill";
import {
  useConfigQuery,
  useRefresh,
  useStatusQuery,
  useUsageQuery,
} from "./hooks/useData";
import { resolveFilterRange, useFilters } from "./hooks/useFilters";
import { useNow } from "./hooks/useNow";
import { useTheme } from "./hooks/useTheme";
import { useToasts } from "./hooks/useToasts";

function isEmptyView(usage: UsageResponse): boolean {
  return (
    usage.totals.cost === 0 &&
    usage.totals.totalTokens === 0 &&
    usage.tables.sessions.length === 0
  );
}

export function App() {
  const { theme, toggleTheme } = useTheme();
  const now = useNow();
  const { pushToast } = useToasts();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // True when settings was opened from the onboarding CTA — the dialog
  // then lands directly in the add-host form.
  const [settingsAutoAdd, setSettingsAutoAdd] = useState(false);

  const configQuery = useConfigQuery();
  const statusQuery = useStatusQuery();
  const { startRefresh, starting } = useRefresh(statusQuery.data);

  const {
    filters,
    setPreset,
    setCustomRange,
    toggleHost,
    toggleAgent,
    resetFilters,
  } = useFilters();

  const timezone = configQuery.data?.timezone;
  const today = useMemo(
    () => (timezone !== undefined ? todayInTz(timezone, now) : null),
    [timezone, now],
  );

  const activeRange = today !== null ? resolveFilterRange(filters, today) : null;

  const usageParams: UsageParams | null =
    activeRange !== null
      ? {
          from: activeRange.from,
          to: activeRange.to,
          hosts: filters.hosts,
          agents: filters.agents,
        }
      : null;

  const usageQuery = useUsageQuery(usageParams);
  const usage = usageQuery.data;

  // FR7 — error toasts include the actual failure reason.
  const usageError = usageQuery.error;
  useEffect(() => {
    if (usageError !== null) {
      pushToast("negative", "Failed to load usage data", usageError.message);
    }
  }, [usageError, pushToast]);
  const configError = configQuery.error;
  useEffect(() => {
    if (configError !== null) {
      pushToast("negative", "Failed to load config", configError.message);
    }
  }, [configError, pushToast]);

  const hostColors = useMemo(
    () => (usage !== undefined ? buildHostColorMap(usage) : new Map<string, string>()),
    [usage],
  );
  const agentColors = useMemo(
    () => buildHarnessColorMap(usage?.availableAgents ?? []),
    [usage],
  );
  // Model ramp assigned by cost rank = API row order (brief §2.3).
  const modelColorByKey = useMemo(() => {
    const map = new Map<string, string>();
    let rank = 0;
    for (const row of usage?.tables.byModel ?? []) {
      map.set(
        row.key,
        row.key === OTHER_MODELS_KEY
          ? OTHER_MODEL_COLOR
          : rank < MODEL_RAMP.length
            ? (MODEL_RAMP[rank++] as string)
            : OTHER_MODEL_COLOR,
      );
    }
    return map;
  }, [usage]);

  // "vs prior 30d" suffix — preset label when a *d preset is active,
  // otherwise the actual range length (brief §6.2).
  const periodLabel = useMemo(() => {
    if (filters.preset !== null && filters.preset.endsWith("d")) return filters.preset;
    const days = usage?.dateAxis.length ?? 0;
    return `${days}d`;
  }, [filters.preset, usage]);

  const noHostsConfigured =
    configQuery.data !== undefined && configQuery.data.hosts.length === 0;

  const firstLoad =
    usage === undefined || configQuery.data === undefined;

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)" }}>
      <Header
        status={statusQuery.data}
        theme={theme}
        onToggleTheme={toggleTheme}
        onRefresh={startRefresh}
        refreshStarting={starting}
        onOpenSettings={() => {
          setSettingsAutoAdd(false);
          setSettingsOpen(true);
        }}
        now={now}
      />

      {!noHostsConfigured && (
        <FilterBar
          filters={filters}
          activeRange={activeRange ?? { from: "", to: "" }}
          usage={usage}
          onPreset={setPreset}
          onCustomRange={setCustomRange}
          onToggleHost={toggleHost}
          onToggleAgent={toggleAgent}
        />
      )}

      <main className="page">
        {noHostsConfigured ? (
          <Onboarding
            onAddHost={() => {
              setSettingsAutoAdd(true);
              setSettingsOpen(true);
            }}
          />
        ) : firstLoad ? (
          usageQuery.isError || configQuery.isError ? (
            <div className="flex justify-center py-16">
              <div className="card flex flex-col items-center gap-3" style={{ maxWidth: 400, padding: 24 }}>
                <div className="t-title" style={{ color: "var(--negative)" }}>
                  Couldn't load the dashboard
                </div>
                <p className="t-body" style={{ color: "var(--text-secondary)", margin: 0 }}>
                  {usageQuery.error?.message ?? configQuery.error?.message ?? "unknown error"}
                </p>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => {
                    void usageQuery.refetch();
                    void configQuery.refetch();
                  }}
                >
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <PageSkeleton />
          )
        ) : (
          <div className="flex flex-col gap-6 py-6">
            <WarningsPill warnings={usage.warnings} />

            <KpiGrid usage={usage} periodLabel={periodLabel} />

            {isEmptyView(usage) ? (
              <EmptyState onReset={resetFilters} />
            ) : (
              <>
                <DailyCostChart
                  charts={usage.charts}
                  hostColors={hostColors}
                  availableAgents={usage.availableAgents}
                  height={320}
                />

                <div className="chart-2up">
                  <CumulativeChart
                    series={usage.charts.cumulativeCost}
                    hosts={usage.availableHosts}
                    height={260}
                  />
                  <TokenCompositionChart
                    series={usage.charts.tokenComposition}
                    height={260}
                  />
                </div>

                <div className="breakdown-grid">
                  <BreakdownTable
                    title="By host"
                    rows={usage.tables.byHost}
                    colorOf={(row: BreakdownRow) =>
                      hostColors.get(row.key) ?? OTHER_MODEL_COLOR
                    }
                    dateAxis={usage.dateAxis}
                  />
                  <BreakdownTable
                    title="By harness"
                    rows={usage.tables.byHarness}
                    colorOf={(row: BreakdownRow) => harnessColor(row.key, agentColors)}
                    dateAxis={usage.dateAxis}
                  />
                  <BreakdownTable
                    title="By model"
                    rows={usage.tables.byModel}
                    colorOf={(row: BreakdownRow) =>
                      modelColorByKey.get(row.key) ?? OTHER_MODEL_COLOR
                    }
                    dateAxis={usage.dateAxis}
                    // The model long tail (~30 rows of $0.0x noise) hides
                    // behind an expander so the card stays balanced.
                    maxRows={10}
                  />
                </div>

                <SessionsTable
                  sessions={usage.tables.sessions}
                  hosts={usage.availableHosts}
                  agentColors={agentColors}
                  now={now}
                />
              </>
            )}
          </div>
        )}
      </main>

      <SettingsDialog
        open={settingsOpen}
        config={configQuery.data}
        autoAddHost={settingsAutoAdd}
        onClose={() => setSettingsOpen(false)}
      />
      <Toasts />
    </div>
  );
}
