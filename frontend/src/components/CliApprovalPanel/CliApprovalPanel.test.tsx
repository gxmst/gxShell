import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CliApprovalPanelRequest } from "../../types";
import { CliApprovalPanel } from "./CliApprovalPanel";

function request(overrides: Partial<CliApprovalPanelRequest> = {}): CliApprovalPanelRequest {
  return {
    id: "panel-1",
    source: "cli",
    server: "prod-web",
    summary: "An external CLI request wants to run 3 command(s) on prod-web",
    items: [
      { id: "a", kind: "command", text: "rm -rf /etc", riskTier: "T3", riskLabel: "Critical" },
      { id: "b", kind: "command", text: "systemctl restart nginx", riskTier: "T2", riskLabel: "Bounded" },
      { id: "c", kind: "command", text: "mkdir -p /srv/app", riskTier: "T1", riskLabel: "Recoverable" },
      { id: "d", kind: "command", text: "uptime", riskTier: "T0", riskLabel: "Read-only" },
    ],
    ...overrides,
  };
}

describe("CliApprovalPanel", () => {
  it("groups by risk tier and starts with only the read-only bucket collapsed", () => {
    render(<CliApprovalPanel request={request()} locale="en" onResolve={vi.fn()} />);

    expect(screen.getByText("rm -rf /etc")).toBeInTheDocument();
    expect(screen.getByText("systemctl restart nginx")).toBeInTheDocument();
    // T1 changes state, so it must not be hidden behind a collapsed group.
    expect(screen.getByText("mkdir -p /srv/app")).toBeInTheDocument();
    // Read-only commands are collapsed, not dropped: the count above still
    // reports all four.
    expect(screen.queryByText("uptime")).not.toBeInTheDocument();
    expect(screen.getByText("4 of 4 selected")).toBeInTheDocument();
  });

  it("expands a collapsed group on demand", () => {
    render(<CliApprovalPanel request={request()} locale="en" onResolve={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /Read-only/ }));
    expect(screen.getByText("uptime")).toBeInTheDocument();
  });

  it("shows each item's tier, not just its group", () => {
    const { container } = render(<CliApprovalPanel request={request()} locale="en" onResolve={vi.fn()} />);

    // The native dialog stated the risk level per command; the panel keeps it on
    // the row instead of hiding it behind the explanation toggle.
    expect(screen.getByText("Bounded")).toBeInTheDocument();
    expect(screen.getByText("Recoverable")).toBeInTheDocument();
    const rowTiers = [...container.querySelectorAll(".cli-panel-item-tier")].map((node) => node.textContent);
    expect(rowTiers).toEqual(["T3", "T2", "T1"]);
  });

  it("approves only the selection on Enter, never the whole batch", () => {
    const onResolve = vi.fn();
    render(<CliApprovalPanel request={request()} locale="en" onResolve={onResolve} />);

    // Uncheck the critical command; one keystroke must not run it anyway.
    fireEvent.click(screen.getByLabelText("rm -rf /etc"));
    fireEvent.keyDown(document, { key: "Enter" });

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(["b", "c", "d"]);
  });

  it("denies with an empty decision on Escape", () => {
    const onResolve = vi.fn();
    render(<CliApprovalPanel request={request()} locale="en" onResolve={onResolve} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith([]);
  });

  it("resolves at most once even when a second key arrives", () => {
    const onResolve = vi.fn();
    render(<CliApprovalPanel request={request()} locale="en" onResolve={onResolve} />);

    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  // Enter is the panel-wide approve shortcut, but a focused button owns it.
  // Hijacking it made Enter on Deny approve, and Enter on a group header
  // approve instead of folding the group.
  it("leaves Enter to a focused button", () => {
    const onResolve = vi.fn();
    render(<CliApprovalPanel request={request()} locale="en" onResolve={onResolve} />);

    for (const name of ["Deny", /Read-only/, /Allow all 4/, /Allow 4 selected/]) {
      const button = screen.getByRole("button", { name });
      button.focus();
      fireEvent.keyDown(button, { key: "Enter" });
    }

    // jsdom does not run the browser's implicit button activation, so the click
    // itself is not observable here; what matters is that the panel's global
    // handler stayed out of the way instead of approving on the button's behalf.
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("still approves on Enter when no button has focus", () => {
    const onResolve = vi.fn();
    render(<CliApprovalPanel request={request()} locale="en" onResolve={onResolve} />);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(onResolve).toHaveBeenCalledWith(["a", "b", "c", "d"]);
  });

  it("still denies on Escape from a focused button", () => {
    const onResolve = vi.fn();
    render(<CliApprovalPanel request={request()} locale="en" onResolve={onResolve} />);

    const deny = screen.getByRole("button", { name: "Deny" });
    deny.focus();
    fireEvent.keyDown(deny, { key: "Escape" });

    expect(onResolve).toHaveBeenCalledWith([]);
  });

  it("cannot approve an empty selection", () => {
    const onResolve = vi.fn();
    render(<CliApprovalPanel request={request()} locale="en" onResolve={onResolve} />);

    // Select all, then unselect all: the only remaining way to run anything is
    // the explicit "Allow all" button.
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }));
    expect(screen.getByText("0 of 4 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Allow 0 selected/ })).toBeDisabled();

    fireEvent.keyDown(document, { key: "Enter" });
    expect(onResolve).toHaveBeenCalledWith([]);
  });

  it("allows the whole batch only through the explicit button", () => {
    const onResolve = vi.fn();
    render(<CliApprovalPanel request={request()} locale="en" onResolve={onResolve} />);

    fireEvent.click(screen.getByLabelText("rm -rf /etc"));
    fireEvent.click(screen.getByRole("button", { name: /Allow all 4/ }));

    expect(onResolve).toHaveBeenCalledWith(["a", "b", "c", "d"]);
  });

  it("keeps commands the classifier could not tier visible", () => {
    render(
      <CliApprovalPanel
        request={request({
          items: [{ id: "x", kind: "command", text: "some-opaque-thing" }],
        })}
        locale="en"
        onResolve={vi.fn()}
      />,
    );

    expect(screen.getByText("some-opaque-thing")).toBeInTheDocument();
    expect(screen.getByText("Unclassified")).toBeInTheDocument();
  });

  it("marks a critical request and never folds it into a collapsed group", () => {
    render(
      <CliApprovalPanel
        request={request({ critical: true, items: [request().items[0]] })}
        locale="en"
        onResolve={vi.fn()}
      />,
    );

    expect(screen.getByText(/Critical commands are never grouped away/)).toBeInTheDocument();
    expect(screen.getByText("rm -rf /etc")).toBeInTheDocument();
  });

  it("lists every risk line rather than the first few", () => {
    // The panel scrolls, so there is no reason to drop lines — and the native
    // dialog's own explanation only counted the ones it hid ("and N more").
    const riskLines = ["deletes /etc", "touches credentials", "affects boot", "external host", "sudo"];
    render(
      <CliApprovalPanel
        request={request({
          items: [{ id: "a", kind: "command", text: "rm -rf /etc", riskTier: "T3", riskLines }],
        })}
        locale="en"
        onResolve={vi.fn()}
      />,
    );

    for (const line of riskLines) expect(screen.getByText(line)).toBeInTheDocument();
  });
});
