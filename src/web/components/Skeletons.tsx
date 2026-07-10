/**
 * FR7 — first-load skeletons (brief §6.8): pulsing blocks that mirror
 * the real layout. Never spinners for page content.
 */

function KpiSkeleton() {
  return (
    <div className="card flex flex-col gap-3" style={{ padding: 16, minHeight: 96 }}>
      <div className="skel" style={{ width: 72, height: 12 }} />
      <div className="skel" style={{ width: 120, height: 28 }} />
      <div className="skel" style={{ width: 88, height: 12 }} />
    </div>
  );
}

function ChartSkeleton({ height }: { height: number }) {
  return (
    <div className="card flex flex-col gap-4" style={{ padding: 16 }}>
      <div className="skel" style={{ width: 96, height: 14 }} />
      <div
        className="flex flex-col justify-between"
        style={{ height: height - 60, paddingBottom: 8 }}
        aria-hidden
      >
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="skel" style={{ height: 1, opacity: 0.5 }} />
        ))}
      </div>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="card flex flex-col gap-3" style={{ padding: 16 }}>
      <div className="skel" style={{ width: 80, height: 14 }} />
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="skel" style={{ height: 14, width: `${100 - i * 6}%` }} />
      ))}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6 py-6" aria-busy="true" aria-label="Loading usage data">
      <div className="kpi-grid">
        {Array.from({ length: 8 }, (_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
      <ChartSkeleton height={320} />
      <div className="chart-2up">
        <ChartSkeleton height={260} />
        <ChartSkeleton height={260} />
      </div>
      <div className="breakdown-grid">
        <TableSkeleton />
        <TableSkeleton />
        <TableSkeleton />
      </div>
      <TableSkeleton />
    </div>
  );
}
