/**
 * Tooltip (brief §6.7): floating card, 300ms hover delay / immediate on
 * focus, no arrow. Pure CSS show/hide; the wrapper is focusable so
 * keyboard users get the tooltip too.
 */

import type { ReactNode } from "react";

interface TipProps {
  content: ReactNode;
  children: ReactNode;
  /** Right-align the card (for elements near the viewport's right edge). */
  align?: "center" | "left";
  /**
   * "below" opens the card under the trigger — required for triggers
   * near the viewport top (the 56px header), where an above-placed card
   * would clip off-screen.
   */
  placement?: "above" | "below";
  className?: string;
}

export function Tip({
  content,
  children,
  align = "center",
  placement = "above",
  className,
}: TipProps) {
  const cls = [
    "tip-card",
    align === "left" ? "tip-left" : "",
    placement === "below" ? "tip-below" : "",
  ]
    .filter((s) => s !== "")
    .join(" ");
  return (
    <span className={`tip ${className ?? ""}`} tabIndex={0}>
      {children}
      <span role="tooltip" className={cls}>
        {content}
      </span>
    </span>
  );
}
