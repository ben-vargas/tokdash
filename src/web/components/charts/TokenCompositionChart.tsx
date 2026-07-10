/**
 * FR3 — token composition over time: input / output / cache-create /
 * cache-read. Modes per brief §6.3: % (100%-stacked, default — the mode
 * where all four classes are visible), Linear (stacked areas), Log
 * (unstacked lines, zero days clamped to the floor).
 */

import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatFullNumber, formatPercent, formatTokens } from "../../../shared/format";
import type { TokenCompositionSeries } from "../../../shared/types";
import { TOKEN_CLASS_COLORS } from "../../colors";
import { SegmentedControl } from "../SegmentedControl";
import {
  CHART_MARGIN,
  ChartCard,
  ChartTooltipCard,
  tooltipDateHeader,
  xAxisProps,
  yAxisProps,
  type LegendItem,
} from "./chrome";

type Mode = "linear" | "log" | "percent";

const MODES: readonly { value: Mode; label: string }[] = [
  { value: "linear", label: "Linear" },
  { value: "log", label: "Log" },
  { value: "percent", label: "%" },
];

const CLASSES = [
  { key: "inputTokens", label: "Input", color: TOKEN_CLASS_COLORS.inputTokens },
  { key: "outputTokens", label: "Output", color: TOKEN_CLASS_COLORS.outputTokens },
  {
    key: "cacheCreationTokens",
    label: "Cache write",
    color: TOKEN_CLASS_COLORS.cacheCreationTokens,
  },
  {
    key: "cacheReadTokens",
    label: "Cache read",
    color: TOKEN_CLASS_COLORS.cacheReadTokens,
  },
] as const;

type ClassKey = (typeof CLASSES)[number]["key"];

interface TokenCompositionChartProps {
  series: TokenCompositionSeries;
  height: number;
}

export function TokenCompositionChart({ series, height }: TokenCompositionChartProps) {
  const [mode, setMode] = useState<Mode>("percent");

  const legend: LegendItem[] = CLASSES.map((c) => ({
    id: c.key,
    label: c.label,
    color: c.color,
    ...(mode === "log" ? { line: true } : {}),
  }));

  const tooltip = (
    <Tooltip
      cursor={
        mode === "log"
          ? { stroke: "var(--border-strong)", strokeWidth: 1 }
          : { fill: "var(--chart-cursor)" }
      }
      isAnimationActive={false}
      content={({ active, label }) => {
        if (active !== true || typeof label !== "string") return null;
        const point = series.points.find((p) => p.date === label);
        if (point === undefined) return null;
        const totalDay =
          point.inputTokens +
          point.outputTokens +
          point.cacheCreationTokens +
          point.cacheReadTokens;
        return (
          <ChartTooltipCard
            header={tooltipDateHeader(point.date)}
            rows={CLASSES.map((c) => ({
              id: c.key,
              label:
                mode === "percent" && totalDay > 0
                  ? `${c.label} (${formatPercent(point[c.key] / totalDay)})`
                  : c.label,
              color: c.color,
              value: point[c.key],
            }))}
            formatValue={formatTokens}
            total={{ label: "Total", text: formatFullNumber(totalDay) }}
          />
        );
      }}
    />
  );

  const grid = <CartesianGrid vertical={false} stroke="var(--chart-grid)" />;
  const xAxis = <XAxis dataKey="date" {...xAxisProps()} />;

  return (
    <ChartCard
      title="Token composition"
      ariaLabel="Token composition over time by token class"
      height={height}
      legend={legend}
      controls={
        <SegmentedControl options={MODES} value={mode} onChange={setMode} ariaLabel="Scale mode" />
      }
      caption={mode === "log" ? "log scale; zero days clamped" : undefined}
    >
      <ResponsiveContainer width="100%" height="100%">
        {mode === "log" ? (
          <LineChart data={series.points} margin={CHART_MARGIN}>
            {grid}
            {xAxis}
            <YAxis
              {...yAxisProps("tokens")}
              scale="log"
              domain={[1, "auto"]}
              allowDataOverflow
            />
            {tooltip}
            {CLASSES.map((c) => (
              <Line
                key={c.key}
                type="monotone"
                dataKey={(p: Record<ClassKey, number>) => Math.max(p[c.key], 1)}
                name={c.label}
                stroke={c.color}
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3 }}
                isAnimationActive
                animationDuration={200}
                animationEasing="ease-out"
              />
            ))}
          </LineChart>
        ) : (
          <AreaChart
            data={series.points}
            margin={CHART_MARGIN}
            stackOffset={mode === "percent" ? "expand" : "none"}
          >
            {grid}
            {xAxis}
            {mode === "percent" ? (
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 11, fill: "var(--chart-axis)" }}
                ticks={[0, 0.25, 0.5, 0.75, 1]}
                tickFormatter={(v: number) => formatPercent(v, 0)}
                width={40}
              />
            ) : (
              <YAxis {...yAxisProps("tokens")} />
            )}
            {tooltip}
            {CLASSES.map((c) => (
              <Area
                key={c.key}
                type="monotone"
                dataKey={c.key}
                name={c.label}
                stackId="tok"
                fill={c.color}
                fillOpacity={0.85}
                stroke="none"
                isAnimationActive
                animationDuration={200}
                animationEasing="ease-out"
              />
            ))}
          </AreaChart>
        )}
      </ResponsiveContainer>
    </ChartCard>
  );
}
