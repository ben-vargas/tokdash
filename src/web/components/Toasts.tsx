/**
 * Toast stack renderer (brief §6.7). Left accent border color encodes
 * tone; detail line carries the actual failure reason.
 */

import { useEffect, useRef } from "react";
import { useToasts, type ToastTone } from "../hooks/useToasts";

const TONE_COLOR: Record<ToastTone, string> = {
  info: "var(--accent)",
  positive: "var(--positive)",
  negative: "var(--negative)",
  warning: "var(--warning)",
};

export function Toasts() {
  const { toasts, dismissToast, pauseToast, resumeToast } = useToasts();
  const ref = useRef<HTMLDivElement>(null);

  // The stack is a manual popover so it lives in the browser top layer:
  // toasts fired while the settings <dialog> is modal (e.g. "host
  // saved") would otherwise paint beneath the dialog's scrim and be
  // invisible. Re-showing on every change keeps the stack above the
  // most recently opened top-layer element.
  useEffect(() => {
    const el = ref.current;
    if (el === null || typeof el.showPopover !== "function") return;
    try {
      if (el.matches(":popover-open")) el.hidePopover();
      if (toasts.length > 0) el.showPopover();
    } catch {
      /* popover unavailable — fixed positioning still shows toasts */
    }
  }, [toasts]);

  return (
    <div ref={ref} className="toast-stack" popover="manual" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="toast"
          role="status"
          style={{ borderLeftColor: TONE_COLOR[t.tone] }}
          onMouseEnter={() => pauseToast(t.id)}
          onMouseLeave={() => resumeToast(t.id)}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="t-section" style={{ color: "var(--text-primary)" }}>
                {t.title}
              </div>
              {t.detail !== undefined && (
                <div
                  className="t-label mt-1"
                  style={{ color: "var(--text-secondary)", overflowWrap: "anywhere" }}
                >
                  {t.detail}
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn-ghost"
              style={{ height: 20, padding: "0 4px", flex: "none" }}
              aria-label="Dismiss notification"
              onClick={() => dismissToast(t.id)}
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
