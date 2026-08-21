import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ActivityRecord } from "../../types";
import { ActivityCenter } from "./ActivityCenter";

const records: ActivityRecord[] = [
  {
    id: "a1",
    timestamp: Date.now(),
    text: "Connection restored",
    title: "prod",
    tone: "success",
    severity: "success",
    category: "connection",
    scopeLabel: "prod / ssh",
    unread: true,
    actions: [{ id: "open", label: "Open", variant: "primary" }],
  },
  {
    id: "a2",
    timestamp: Date.now() - 1000,
    text: "Upload failed",
    tone: "error",
    severity: "error",
    category: "transfer",
    unread: false,
  },
];

describe("ActivityCenter", () => {
  it("opens from the bell, filters unread/errors, and marks a row read", () => {
    const onMarkRead = vi.fn();
    render(<ActivityCenter activities={records} onMarkRead={onMarkRead} />);

    fireEvent.click(screen.getByRole("button", { name: "Notification center" }));
    expect(screen.getByRole("dialog", { name: "Notification center" })).toBeInTheDocument();
    expect(screen.getByText("Connection restored")).toBeInTheDocument();
    expect(screen.getByText("Upload failed")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Unread" }));
    expect(screen.getByText("Connection restored")).toBeInTheDocument();
    expect(screen.queryByText("Upload failed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Connection restored"));
    expect(onMarkRead).toHaveBeenCalledWith("a1");

    fireEvent.click(screen.getByRole("tab", { name: "Errors" }));
    expect(screen.getByText("Upload failed")).toBeInTheDocument();
    expect(screen.queryByText("Connection restored")).not.toBeInTheDocument();
  });

  it("calls action and maintenance callbacks", () => {
    const onAction = vi.fn();
    const onMarkAllRead = vi.fn();
    const onClear = vi.fn();
    const onDismiss = vi.fn();
    render(<ActivityCenter activities={records} onAction={onAction} onMarkAllRead={onMarkAllRead} onClear={onClear} onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole("button", { name: "Notification center" }));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onAction).toHaveBeenCalledWith(records[0], records[0].actions![0]);
    fireEvent.click(within(screen.getByRole("dialog")).getAllByRole("button", { name: "Mark all as read" })[0]);
    expect(onMarkAllRead).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss notification" })[0]);
    expect(onDismiss).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Clear notifications" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape and supports a controlled open state", () => {
    const onOpenChange = vi.fn();
    render(<ActivityCenter activities={records} open onOpenChange={onOpenChange} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
