/**
 * Identity swatches (brief §2.4): 8×8 rounded square next to labels;
 * 10×2 rounded rect for line series; 6–8px dots for chip-lets.
 */

export function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 2,
        background: color,
        marginRight: 6,
        flex: "none",
      }}
    />
  );
}

export function LineSwatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 10,
        height: 2,
        borderRadius: 1,
        background: color,
        marginRight: 6,
        flex: "none",
        verticalAlign: "middle",
      }}
    />
  );
}

export function Dot({ color, size = 6 }: { color: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: 999,
        background: color,
        flex: "none",
      }}
    />
  );
}
