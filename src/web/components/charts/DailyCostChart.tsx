/**
 * FR3 — daily cost stacked bars with a host / harness / model stack
 * switch. All three series come precomputed from /api/usage; switching
 * never refetches. Approximate model stacks get the ≈ pill (brief §6.3)
 * and no-model-data bands render hatched (brief §2.3).
 */

import { useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency } from "../../../shared/format";
import type {
  DailyStackedSeries,
  StackDimension,
  StackedPoint,
  UsageCharts,
} from "../../../shared/types";
import {
  buildHarnessColorMap,
  isHatchedKey,
  patternId,
  seriesKeyColor,
} from "../../colors";
import { SegmentedControl } from "../SegmentedControl";
import { Tip } from "../Tip";
import {
  CHART_MARGIN,
  ChartCard,
  ChartTooltipCard,
  tooltipDateHeader,
  xAxisProps,
  yAxisProps,
  type LegendItem,
} from "./chrome";

const DIMENSIONS: readonly { value: StackDimension; label: string }[] = [
  { value: "host", label: "Host" },
  { value: "harness", label: "Harness" },
  { value: "model", label: "Model" },
];

interface DailyCostChartProps {
  charts: UsageCharts;
  hostColors: ReadonlyMap<string, string>;
  availableAgents: readonly string[];
  height: number;
}

export function DailyCostChart({
  charts,
  hostColors,
  availableAgents,
  height,
}: DailyCostChartProps) {
  const [dimension, setDimension] = useState<StackDimension>("host");

  const series: DailyStackedSeries =
    dimension === "host"
      ? charts.dailyCostByHost
      : dimension === "harness"
        ? charts.dailyCostByHarness
        : charts.dailyCostByModel;

  const agentColors = useMemo(
    () => buildHarnessColorMap(availableAgents),
    [availableAgents],
  );

  // Colors resolved once per series; model ramp is assigned by cost rank
  // = API key order among kind==="model" keys (brief §2.3).
  const keyColors = useMemo(() => {
    const map = new Map<string, string>();
    let modelRank = 0;
    for (const key of series.keys) {
      map.set(
        key.id,
        seriesKeyColor(key, key.kind === "model" ? modelRank++ : 0, hostColors, agentColors),
      );
    }
    return map;
  }, [series.keys, hostColors, agentColors]);

  // Topmost nonzero key per date — only that segment gets rounded corners.
  const topKeyByDate = useMemo(() => {
    const map = new Map<string, string>();
    for (const point of series.points) {
      for (let i = series.keys.length - 1; i >= 0; i--) {
        const key = series.keys[i];
        if (key !== undefined && (point.values[key.id] ?? 0) > 0) {
          map.set(point.date, key.id);
          break;
        }
      }
    }
    return map;
  }, [series]);

  const legend: LegendItem[] = series.keys.map((key) => {
    const item: LegendItem = {
      id: key.id,
      label: key.label,
      color: keyColors.get(key.id) ?? "#8d867e",
    };
    if (isHatchedKey(key)) item.hatched = true;
    return item;
  });

  const hatchedKeys = series.keys.filter((k) => isHatchedKey(k));

  return (
    <ChartCard
      title="Daily cost"
      ariaLabel={`Daily cost stacked by ${dimension}`}
      height={height}
      legend={legend}
      badge={
        series.exact === false ? (
          <Tip content={series.note ?? "Model stacks are approximate under a harness subset."}>
            <span className="badge badge-warning">≈ approximate</span>
          </Tip>
        ) : undefined
      }
      controls={
        <SegmentedControl
          options={DIMENSIONS}
          value={dimension}
          onChange={setDimension}
          ariaLabel="Stack dimension"
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={series.points} margin={CHART_MARGIN} barCategoryGap="20%">
          <defs>
            {hatchedKeys.map((key) => {
              const color = keyColors.get(key.id) ?? "#8d867e";
              return (
                <pattern
                  key={key.id}
                  id={patternId("tokdash-hatch", key.id)}
                  patternUnits="userSpaceOnUse"
                  width={4}
                  height={4}
                  patternTransform="rotate(45)"
                >
                  <rect width={4} height={4} fill={color} opacity={0.16} />
                  <rect width={2} height={4} fill={color} opacity={0.4} />
                </pattern>
              );
            })}
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis dataKey="date" {...xAxisProps()} />
          <YAxis {...yAxisProps("cost")} />
          <Tooltip
            cursor={{ fill: "var(--chart-cursor)" }}
            isAnimationActive={false}
            content={({ active, label }) => {
              if (active !== true || typeof label !== "string") return null;
              const point = series.points.find((p) => p.date === label);
              if (point === undefined) return null;
              return (
                <ChartTooltipCard
                  header={tooltipDateHeader(point.date)}
                  rows={series.keys.map((key) => ({
                    id: key.id,
                    label: key.label,
                    color: keyColors.get(key.id) ?? "#8d867e",
                    value: point.values[key.id] ?? 0,
                  }))}
                  formatValue={formatCurrency}
                  total={{ label: "Total", text: formatCurrency(point.total) }}
                />
              );
            }}
          />
          {series.keys.map((key) => {
            const color = keyColors.get(key.id) ?? "#8d867e";
            const fill = isHatchedKey(key)
              ? `url(#${patternId("tokdash-hatch", key.id)})`
              : color;
            return (
              <Bar
                key={key.id}
                dataKey={(p: StackedPoint) => p.values[key.id] ?? 0}
                name={key.label}
                stackId="daily"
                fill={fill}
                maxBarSize={28}
                isAnimationActive
                animationDuration={200}
                animationEasing="ease-out"
                shape={(props: unknown) => {
                  const p = props as {
                    payload?: StackedPoint;
                  } & Record<string, unknown>;
                  const isTop =
                    p.payload !== undefined &&
                    topKeyByDate.get(p.payload.date) === key.id;
                  return (
                    <Rectangle
                      {...(p as object)}
                      radius={isTop ? [2, 2, 0, 0] : undefined}
                    />
                  );
                }}
              />
            );
          })}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
