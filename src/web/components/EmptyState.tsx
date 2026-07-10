/**
 * FR7 — empty state when the active filters exclude everything (brief
 * §6.8). Replaces charts/tables only; KPI cards keep rendering $0.00.
 */

export function EmptyState({ onReset }: { onReset: () => void }) {
  return (
    <div className="flex justify-center py-16">
      <div className="flex flex-col items-center gap-3 text-center" style={{ maxWidth: 360 }}>
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden>
          <path
            d="M5 32V12M5 32h30M11 26l6-7 5 4 7-9"
            stroke="var(--text-disabled)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="3 3"
          />
        </svg>
        <div className="t-title">Nothing in this view</div>
        <p className="t-body" style={{ color: "var(--text-secondary)", margin: 0 }}>
          No usage matches the current date range, hosts, and harnesses.
        </p>
        <button type="button" className="btn-ghost" style={{ border: "1px solid var(--border-strong)" }} onClick={onReset}>
          Reset filters
        </button>
      </div>
    </div>
  );
}
