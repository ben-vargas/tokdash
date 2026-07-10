/**
 * Segmented control (brief §6.1): inset track, raised active segment.
 * Buttons carry aria-pressed for accessibility.
 */

interface SegmentedControlProps<T extends string> {
  options: readonly { value: T; label: string }[];
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className="seg-btn"
          aria-pressed={opt.value === value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
