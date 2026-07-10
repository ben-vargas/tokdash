/**
 * FR7 — onboarding state when no hosts are configured (brief §6.8).
 */

export function Onboarding({ onAddHost }: { onAddHost: () => void }) {
  return (
    <div className="flex justify-center py-16">
      <div className="card flex flex-col gap-4" style={{ maxWidth: 440, padding: 24 }}>
        <div className="t-title">Add your first host</div>
        <p className="t-body" style={{ color: "var(--text-secondary)", margin: 0 }}>
          TokDash aggregates <code>ccusage</code> usage across machines. A host with no
          SSH alias runs ccusage locally; a host with an alias runs it remotely over
          your existing SSH config.
        </p>
        <div
          className="t-mono inset-well"
          style={{ padding: "8px 10px", color: "var(--text-secondary)" }}
        >
          bunx ccusage@latest
        </div>
        <div>
          <button type="button" className="btn-primary" onClick={onAddHost}>
            Add host
          </button>
        </div>
      </div>
    </div>
  );
}
