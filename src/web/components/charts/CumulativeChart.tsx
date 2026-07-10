/**
 * FR3 — cumulative cost lines: one per host (host color) + Combined
 * (text-primary at 90%, heavier stroke). No area fills (brief §6.3).
 */

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "../../../shared/format";
import type { CumulativePoint, CumulativeSeries, HostRef } from "../../../shared/types";
import {
  CHART_MARGIN,
  ChartCard,
  ChartTooltipCard,
  tooltipDateHeader,
  xAxisProps,
  yAxisProps,
  type LegendItem,
} from "./chrome";

const COMBINED_COLOR = "color-mix(in srgb, var(--text-primary) 90%, transparent)";

interface CumulativeChartProps {
  series: CumulativeSeries;
  hosts: readonly HostRef[];
  height: number;
}

export function CumulativeChart({ series, hosts, height }: CumulativeChartProps) {
  const hostById = new Map(hosts.map((h) => [h.id, h]));
  const lines = series.hostIds.map((id) => ({
    id,
    label: hostById.get(id)?.label ?? id,
    color: hostById.get(id)?.color ?? "#8d867e",
  }));

  const legend: LegendItem[] = [
    ...lines.map((l) => ({ id: l.id, label: l.label, color: l.color, line: true })),
    { id: "__combined__", label: "Combined", color: "var(--text-primary)", line: true },
  ];

  return (
    <ChartCard
      title="Cumulative cost"
      ariaLabel="Cumulative cost per host and combined"
      height={height}
      legend={legend}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={series.points} margin={CHART_MARGIN}>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="date" {...xAxisProps()} />
          <YAxis {...yAxisProps("cost")} />
          <Tooltip
            cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
            isAnimationActive={false}
            content={({ active, label }) => {
              if (active !== true || typeof label !== "string") return null;
              const point = series.points.find((p) => p.date === label);
              if (point === undefined) return null;
              return (
                <ChartTooltipCard
                  header={tooltipDateHeader(point.date)}
                  rows={lines.map((l) => ({
                    id: l.id,
                    label: l.label,
                    color: l.color,
                    value: point.byHost[l.id] ?? 0,
                  }))}
                  formatValue={formatCurrency}
                  total={{ label: "Combined", text: formatCurrency(point.combined) }}
                />
              );
            }}
          />
          {lines.map((l) => (
            <Line
              key={l.id}
              type="monotone"
              dataKey={(p: CumulativePoint) => p.byHost[l.id] ?? 0}
              name={l.label}
              stroke={l.color}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3 }}
              isAnimationActive
              animationDuration={200}
              animationEasing="ease-out"
            />
          ))}
          <Line
            type="monotone"
            dataKey={(p: CumulativePoint) => p.combined}
            name="Combined"
            stroke={COMBINED_COLOR}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
            isAnimationActive
            animationDuration={200}
            animationEasing="ease-out"
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
