/**
 * Toast store (brief §6.7): bottom-right stack, max 3, auto-dismiss 6s
 * (errors 10s), hover pauses. Every error toast carries the actual
 * failure reason in `detail`.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastTone = "info" | "positive" | "negative" | "warning";

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  detail?: string;
}

interface ToastContextValue {
  toasts: Toast[];
  pushToast: (tone: ToastTone, title: string, detail?: string) => void;
  dismissToast: (id: number) => void;
  pauseToast: (id: number) => void;
  resumeToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_TOASTS = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const remaining = useRef(new Map<number, { deadline: number; ms: number }>());

  const dismissToast = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t !== undefined) clearTimeout(t);
    timers.current.delete(id);
    remaining.current.delete(id);
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);

  const schedule = useCallback(
    (id: number, ms: number) => {
      remaining.current.set(id, { deadline: Date.now() + ms, ms });
      timers.current.set(
        id,
        setTimeout(() => dismissToast(id), ms),
      );
    },
    [dismissToast],
  );

  const pushToast = useCallback(
    (tone: ToastTone, title: string, detail?: string) => {
      const id = nextId.current++;
      const toast: Toast = detail !== undefined ? { id, tone, title, detail } : { id, tone, title };
      setToasts((prev) => {
        const next = [...prev, toast];
        // Cap the stack at 3 — evict the oldest.
        while (next.length > MAX_TOASTS) {
          const evicted = next.shift();
          if (evicted) {
            const t = timers.current.get(evicted.id);
            if (t !== undefined) clearTimeout(t);
            timers.current.delete(evicted.id);
          }
        }
        return next;
      });
      schedule(id, tone === "negative" ? 10_000 : 6_000);
    },
    [schedule],
  );

  const pauseToast = useCallback((id: number) => {
    const t = timers.current.get(id);
    const r = remaining.current.get(id);
    if (t !== undefined && r !== undefined) {
      clearTimeout(t);
      timers.current.delete(id);
      remaining.current.set(id, {
        deadline: 0,
        ms: Math.max(1000, r.deadline - Date.now()),
      });
    }
  }, []);

  const resumeToast = useCallback(
    (id: number) => {
      const r = remaining.current.get(id);
      if (r !== undefined && !timers.current.has(id)) {
        schedule(id, r.ms);
      }
    },
    [schedule],
  );

  const value = useMemo(
    () => ({ toasts, pushToast, dismissToast, pauseToast, resumeToast }),
    [toasts, pushToast, dismissToast, pauseToast, resumeToast],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (ctx === null) {
    throw new Error("useToasts must be used within ToastProvider");
  }
  return ctx;
}
