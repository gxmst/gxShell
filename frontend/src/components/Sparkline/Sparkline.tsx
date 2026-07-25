import { useMemo } from "react";

/**
 * A minimal SVG sparkline for monitor history.
 *
 * Hand-written rather than pulled from a chart library: the whole requirement is
 * one polyline in a fixed box, and the smallest charting dependency would add
 * more bundle weight than the entire monitor panel. There are no axes, ticks or
 * tooltips on purpose — this sits next to a number that already gives the
 * current value, and its job is only to show the shape of the recent past.
 */
export function Sparkline({
  values,
  max,
  height = 28,
  className,
  label,
}: {
  values: number[];
  /**
   * Upper bound of the vertical scale. Percentages pass 100 so the line stays
   * comparable between renders; throughput passes undefined to auto-scale to
   * its own peak, since it has no natural ceiling.
   */
  max?: number;
  height?: number;
  className?: string;
  /** Accessible description; the graphic is decorative without it. */
  label?: string;
}) {
  // The viewBox is in abstract units and the SVG scales to its container, so a
  // fixed width here costs nothing and keeps the path math simple.
  const width = 100;

  const path = useMemo(() => {
    if (values.length < 2) return "";
    // Auto-scale leaves headroom so a flat line at the peak is still visible as
    // a line rather than sitting exactly on the top edge.
    const peak = max ?? Math.max(...values, 1) * 1.1;
    const scale = peak > 0 ? peak : 1;
    const step = width / (values.length - 1);
    return values
      .map((value, index) => {
        const clamped = Math.max(0, Math.min(scale, value));
        // SVG y grows downward, so a high value has to become a low y.
        const y = height - (clamped / scale) * height;
        return `${index === 0 ? "M" : "L"}${(index * step).toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }, [values, max, height]);

  // Below two samples there is no line to draw. Rendering the empty box anyway
  // keeps the panel from reflowing once the second sample arrives.
  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      height={height}
      width="100%"
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {path && (
        <path
          d={path}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
