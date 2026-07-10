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
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
