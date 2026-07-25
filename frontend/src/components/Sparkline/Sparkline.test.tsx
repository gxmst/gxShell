import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sparkline } from "./Sparkline";

// Reads the polyline's points back out of the rendered SVG so the assertions are
// about the geometry the user sees, not about internal state.
function pathOf(container: HTMLElement): string {
  return container.querySelector("path")?.getAttribute("d") ?? "";
}

function pointsOf(container: HTMLElement): { x: number; y: number }[] {
  return pathOf(container)
    .split(" ")
    .filter(Boolean)
    .map((token) => {
      const [x, y] = token.slice(1).split(",");
      return { x: Number(x), y: Number(y) };
    });
}

describe("Sparkline", () => {
  it("draws nothing until there are two samples", () => {
    const { container: empty } = render(<Sparkline values={[]} max={100} />);
    expect(empty.querySelector("path")).toBeNull();

    const { container: single } = render(<Sparkline values={[42]} max={100} />);
    expect(single.querySelector("path")).toBeNull();
  });

  it("still renders the svg box with no line, so the panel does not reflow later", () => {
    const { container } = render(<Sparkline values={[]} max={100} />);
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("maps a high value to a low y, since SVG y grows downward", () => {
    const { container } = render(<Sparkline values={[0, 100]} max={100} height={28} />);
    const points = pointsOf(container);
    expect(points).toHaveLength(2);
    // 0% sits on the bottom edge, 100% on the top.
    expect(points[0].y).toBeCloseTo(28, 1);
    expect(points[1].y).toBeCloseTo(0, 1);
  });

  it("spreads samples evenly across the full width", () => {
    const { container } = render(<Sparkline values={[10, 20, 30]} max={100} />);
    const points = pointsOf(container);
    expect(points.map((p) => p.x)).toEqual([0, 50, 100]);
  });

  it("holds a fixed scale when max is given, so renders stay comparable", () => {
    // The same value must land at the same height regardless of its neighbours.
    const { container: low } = render(<Sparkline values={[50, 10]} max={100} height={28} />);
    const { container: high } = render(<Sparkline values={[50, 90]} max={100} height={28} />);
    expect(pointsOf(low)[0].y).toBeCloseTo(pointsOf(high)[0].y, 1);
  });

  it("auto-scales with headroom when max is omitted, keeping the peak off the edge", () => {
    const { container } = render(<Sparkline values={[0, 500]} height={28} />);
    const peak = pointsOf(container)[1];
    // Auto-scale adds 10%, so the maximum sample sits just below the top edge
    // rather than exactly on it.
    expect(peak.y).toBeGreaterThan(0);
    expect(peak.y).toBeLessThan(28 * 0.2);
  });

  it("clamps values above the declared max instead of overflowing the box", () => {
    const { container } = render(<Sparkline values={[0, 250]} max={100} height={28} />);
    const points = pointsOf(container);
    expect(points[1].y).toBeCloseTo(0, 1);
    expect(points[1].y).toBeGreaterThanOrEqual(0);
  });

  it("does not divide by zero when every sample is zero", () => {
    const { container } = render(<Sparkline values={[0, 0, 0]} height={28} />);
    for (const point of pointsOf(container)) {
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });

  it("is exposed to assistive tech only when it carries a label", () => {
    const { container: labelled } = render(<Sparkline values={[1, 2]} label="CPU history" />);
    const svg = labelled.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("CPU history");
    expect(svg.getAttribute("aria-hidden")).toBeNull();

    const { container: bare } = render(<Sparkline values={[1, 2]} />);
    expect(bare.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
});
