/**
 * FR7 — dark default with persisted light toggle. The inline script in
 * index.html applies the attribute before first paint; this hook keeps
 * React state in sync and persists changes.
 */

import { useCallback, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "tokdash-theme";

function readInitialTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" ? "light" : "dark";
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // storage unavailable — theme still applies for this session
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
