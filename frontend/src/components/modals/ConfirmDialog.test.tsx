import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  it("locks repeated confirmation attempts and recovers after a failure", async () => {
    let rejectConfirm: (reason?: unknown) => void = () => undefined;
    const pending = new Promise<void>((_resolve, reject) => { rejectConfirm = reject; });
    const onConfirm = vi.fn(() => pending);
    const onClose = vi.fn();

    render(
      <ConfirmDialog
        title="Delete profile?"
        body="This cannot be undone."
        confirmText="Delete"
        onConfirm={onConfirm}
        onClose={onClose}
      />,
    );

    const confirmButton = screen.getByRole("button", { name: "Delete" });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(confirmButton).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => rejectConfirm(new Error("delete failed")));

    expect(screen.getByRole("alert")).toHaveTextContent("delete failed");
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
  });
});
