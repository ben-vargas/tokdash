/**
 * Horizontal-scroll wrapper for tables (brief §4.3/§8.7). The first
 * column stays sticky (CSS); when content actually overflows, a 16px
 * right-edge fade mask + always-visible thin scrollbar signal the
 * hidden columns — a numeral must never appear hard-clipped mid-glyph.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

export function TableScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fadeRight, setFadeRight] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const update = () =>
      setFadeRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Column visibility (container queries) and sorting change the
    // table's intrinsic width without resizing the scroll container.
    if (el.firstElementChild !== null) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  return (
    <div ref={ref} className="table-scroll" data-fade-right={fadeRight}>
      {children}
    </div>
  );
}
