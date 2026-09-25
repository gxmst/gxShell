import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { registerOverlay } from "../../utils/overlayManager";
import { FloatingCard } from "./FloatingCard";

// The handler is a document-level capture listener, so Escape must be dispatched
// on whatever currently holds the focus for the target to be realistic.
const pressEscape = (target: Element) => fireEvent.keyDown(target, { key: "Escape" });

describe("FloatingCard", () => {
  it("closes only the topmost card on a single Escape", () => {
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    render(<FloatingCard onClose={closeFirst}><div>first</div></FloatingCard>);
    render(<FloatingCard onClose={closeSecond}><div>second</div></FloatingCard>);

    pressEscape(document.body);

    expect(closeSecond).toHaveBeenCalledTimes(1);
    expect(closeFirst).not.toHaveBeenCalled();
  });

  it("leaves Escape to a terminal that is not inside the card", () => {
    const onClose = vi.fn();
    render(<FloatingCard onClose={onClose}><div>card</div></FloatingCard>);
    // A terminal in the main area, which is the case that matters: a card open
    // while the user is running vim.
    const host = document.createElement("div");
    host.className = "xterm";
    const input = document.createElement("textarea");
    host.appendChild(input);
    document.body.appendChild(host);
    input.focus();

    pressEscape(input);

    // The card must not swallow the Escape that vim (and every other
    // full-screen program) needs.
    expect(onClose).not.toHaveBeenCalled();
    host.remove();
  });

  it("leaves Escape to an open modal", () => {
    const onClose = vi.fn();
    const unregister = registerOverlay("test-modal");
    render(<FloatingCard onClose={onClose}><div>card</div></FloatingCard>);

    pressEscape(document.body);
    expect(onClose).not.toHaveBeenCalled();

    // With the modal gone the card owns Escape again.
    unregister();
    pressEscape(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the focus is inside the card", () => {
    const onClose = vi.fn();
    render(<FloatingCard onClose={onClose}><input data-testid="card-input" /></FloatingCard>);
    const input = screen.getByTestId("card-input");
    input.focus();

    pressEscape(input);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
