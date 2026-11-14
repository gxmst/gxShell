import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LogsPanel } from "./LogsPanel";

const mocks = vi.hoisted(() => ({ application: vi.fn(), sessions: vi.fn() }));
vi.mock("../../../wailsjs/go/app/App", () => ({
  ListLogFiles: mocks.application,
  ListSessionLogFiles: mocks.sessions,
}));

describe("LogsPanel tabs", () => {
  beforeEach(() => {
    mocks.application.mockResolvedValue([{ name: "application.log", size: 100, modTime: "" }]);
    mocks.sessions.mockResolvedValue([{ name: "session.log", size: 100, modTime: "" }]);
  });

  it("uses keyboard selection to load and label the matching log list", async () => {
    const openLog = vi.fn();
    render(<LogsPanel locale="en" activities={[]} onOpenLog={openLog} />);
    await screen.findByText("application.log");
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0].tabIndex).toBe(-1);
    expect(tabs[1].tabIndex).toBe(0);
    const panel = screen.getByRole("tabpanel");
    expect(panel.id).toBe(tabs[1].getAttribute("aria-controls"));
    expect(panel).toHaveAttribute("aria-labelledby", tabs[1].id);
    await within(panel).findByText("session.log");
    fireEvent.click(within(panel).getByRole("button", { name: /session.log/ }));
    expect(openLog).toHaveBeenCalledWith("session.log", true);
    fireEvent.keyDown(tabs[1], { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByText("application.log")).toBeInTheDocument());
    expect(tabs[0]).toHaveFocus();
  });
});
