import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppTopBar } from "./AppTopBar";

const bindings = vi.hoisted(() => ({
  close: vi.fn(),
  isMaximised: vi.fn(),
  minimise: vi.fn(),
  toggleMaximise: vi.fn(),
}));

vi.mock("../../../wailsjs/go/app/App", () => ({
  CloseWindow: bindings.close,
  IsWindowMaximised: bindings.isMaximised,
  MinimiseWindow: bindings.minimise,
  ToggleMaximiseWindow: bindings.toggleMaximise,
}));

describe("AppTopBar", () => {
  beforeEach(() => {
    bindings.close.mockReset();
    bindings.minimise.mockReset();
    bindings.isMaximised.mockReset();
    bindings.isMaximised.mockResolvedValue(false);
    bindings.toggleMaximise.mockReset();
    bindings.toggleMaximise.mockResolvedValue(true);
  });

  it("drives the window through the bound controls", async () => {
    render(<AppTopBar language="en" tabbar={<div className="tabbar" />} />);

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(bindings.minimise).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    expect(bindings.toggleMaximise).toHaveBeenCalledTimes(1);
    // The bound call reports the resulting state, so the glyph flips without a
    // follow-up query.
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(bindings.close).toHaveBeenCalledTimes(1);
  });

  it("reports maximized changes so the shell can compensate for the frame", async () => {
    const onMaximizedChange = vi.fn();
    render(<AppTopBar language="en" tabbar={null} onMaximizedChange={onMaximizedChange} />);

    await waitFor(() => expect(onMaximizedChange).toHaveBeenCalledWith(false));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    await waitFor(() => expect(onMaximizedChange).toHaveBeenLastCalledWith(true));
  });

  // Wails starts a window drag from any element whose computed
  // --wails-draggable is "drag". Double-click must only maximize where a single
  // click would have dragged, or double-clicking a tab title would resize the
  // window instead of doing nothing.
  it("only treats a double-click on a drag region as maximize", () => {
    const { container } = render(<AppTopBar language="en" tabbar={<div data-testid="strip" className="tabbar" />} />);

    const bar = container.querySelector(".topbar") as HTMLElement;
    bar.style.setProperty("--wails-draggable", "drag");
    const strip = screen.getByTestId("strip");
    strip.style.setProperty("--wails-draggable", "no-drag");

    fireEvent.doubleClick(strip);
    expect(bindings.toggleMaximise).not.toHaveBeenCalled();

    fireEvent.doubleClick(bar);
    expect(bindings.toggleMaximise).toHaveBeenCalledTimes(1);
  });
});
