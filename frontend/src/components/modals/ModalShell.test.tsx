import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModalShell } from "./ModalShell";

describe("ModalShell", () => {
  it("focuses the first field, traps Tab, and closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <>
        <button type="button">Terminal</button>
        <ModalShell onClose={onClose} ariaLabel="Preferences">
          <input aria-label="Search" />
          <button type="button">Save</button>
        </ModalShell>
      </>,
    );

    const search = screen.getByRole("textbox", { name: "Search" });
    await waitFor(() => expect(search).toHaveFocus());

    const save = screen.getByRole("button", { name: "Save" });
    save.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(search).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("gives ownership to the highest-priority nested overlay", async () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <>
        <ModalShell onClose={closeOuter} priority={0} ariaLabel="Outer">
          <button type="button">Outer action</button>
        </ModalShell>
        <ModalShell onClose={closeInner} priority={10} ariaLabel="Inner">
          <button type="button">Inner action</button>
        </ModalShell>
      </>,
    );

    await waitFor(() => {
      const backdrops = Array.from(document.querySelectorAll<HTMLElement>(".modal-backdrop"));
      expect(backdrops).toHaveLength(2);
      expect(backdrops.filter((item) => item.dataset.overlayOwner === "true")).toHaveLength(1);
      expect(backdrops.find((item) => item.getAttribute("aria-hidden") === "true")).toBeTruthy();
    });

    const dialogs = screen.getAllByRole("dialog", { hidden: true });
    fireEvent.keyDown(dialogs[0], { key: "Escape" });
    expect(closeOuter).not.toHaveBeenCalled();
    fireEvent.keyDown(dialogs[1], { key: "Escape" });
    expect(closeInner).toHaveBeenCalledTimes(1);
  });

  it("restores the original focus after a nested overlay is removed", async () => {
    const origin = document.createElement("button");
    origin.type = "button";
    origin.textContent = "Open";
    document.body.appendChild(origin);
    origin.focus();

    const closeInner = vi.fn();
    const { rerender, unmount } = render(
      <ModalShell onClose={vi.fn()} priority={0} ariaLabel="Outer">
        <button type="button">Outer action</button>
      </ModalShell>,
    );
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Outer" })).toBeInTheDocument());

    rerender(
      <>
        <ModalShell onClose={vi.fn()} priority={0} ariaLabel="Outer">
          <button type="button">Outer action</button>
        </ModalShell>
        <ModalShell onClose={closeInner} priority={10} ariaLabel="Inner">
          <button type="button">Inner action</button>
        </ModalShell>
      </>,
    );
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Inner" })).toBeInTheDocument());

    rerender(
      <ModalShell onClose={vi.fn()} priority={0} ariaLabel="Outer">
        <button type="button">Outer action</button>
      </ModalShell>,
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Inner" })).not.toBeInTheDocument());
    unmount();
    await waitFor(() => expect(origin).toHaveFocus());
  });
});
