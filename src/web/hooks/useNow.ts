/**
 * A slowly-ticking "now" for relative timestamps ("refreshed 3m ago").
 * 30s resolution is enough for minute-level labels and keeps re-renders
 * negligible.
 */

import { useEffect, useState } from "react";

export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    const syncWhenVisible = () => {
      if (document.visibilityState === "visible") setNow(new Date());
    };
    document.addEventListener("visibilitychange", syncWhenVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", syncWhenVisible);
    };
  }, [intervalMs]);
  return now;
}
