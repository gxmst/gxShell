import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Tab } from "../../types";
import { TabBar } from "./TabBar";

const tabs: Tab[] = Array.from({ length: 12 }, (_, index) => ({
  id: `tab-${index + 1}`,
  profileId: `profile-${index + 1}`,
  title: `Server ${index + 1}`,
  state: "connected",
  type: "ssh",
}));

describe("TabBar overflow", () => {
  it("keeps custom names and full host details available for a single long tab", () => {
    const title = "Production / Shanghai / primary database / maintenance terminal";
    const profile = { id: "profile-1", name: "Database server", host: "db.example.test", username: "ops", port: 2222 } as any;
    const tab = { ...tabs[0], title };
    render(<TabBar tabs={[tab]} activeTab={tab.id} profiles={[profile]} onActive={vi.fn()} onClose={vi.fn()} onReconnect={vi.fn()} language="en" />);
    expect(screen.getByRole("tab").closest(".tab")).toHaveAttribute("title", `${title}\nDatabase server\nops@db.example.test:2222`);
    fireEvent.click(screen.getByRole("button", { name: "All tabs" }));
    const menu = screen.getByRole("dialog", { name: "All tabs" });
    expect(within(menu).getByRole("button", { name: title })).toHaveTextContent("ops@db.example.test:2222");
    fireEvent.change(within(menu).getByRole("textbox"), { target: { value: "db.example" } });
    expect(menu.querySelectorAll('.tab-overflow-main')).toHaveLength(1);
    fireEvent.change(within(menu).getByRole("textbox"), { target: { value: "missing" } });
    expect(within(menu).getByRole("status")).toHaveTextContent("No matching tabs");
  });

  it("offers a new independent terminal for a saved server", () => {
    const onNewTerminal = vi.fn();
    const saved = { ...tabs[0], profileId: "profile-1" };
    render(
      <TabBar tabs={[saved]} activeTab={saved.id} profiles={[{ id: "profile-1" } as any]} onActive={vi.fn()} onClose={vi.fn()} onReconnect={vi.fn()} onNewTerminal={onNewTerminal} language="en" />,
    );
    fireEvent.contextMenu(screen.getByRole("tab", { name: saved.title }).closest(".tab") as HTMLElement);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Open in new terminal" }));
    expect(onNewTerminal).toHaveBeenCalledWith(saved);
  });

  it("keeps every tab available through the compact strip and all-tabs menu", () => {
    const onActive = vi.fn();
    const onClose = vi.fn();

    render(
      <TabBar
        tabs={tabs}
        activeTab="tab-1"
        profiles={[]}
        onActive={onActive}
        onClose={onClose}
        onReconnect={vi.fn()}
        language="en"
      />,
    );

    expect(screen.getAllByRole("tab")).toHaveLength(12);
    expect(document.querySelectorAll(".tab")).toHaveLength(12);

    fireEvent.click(screen.getByRole("button", { name: "All tabs" }));
    const menu = screen.getByRole("dialog", { name: "All tabs" });
    expect(menu.querySelectorAll('.tab-overflow-main')).toHaveLength(12);
    fireEvent.click(within(menu).getByRole("button", { name: "Server 12" }));
    expect(onActive).toHaveBeenLastCalledWith("tab-12");

    fireEvent.click(screen.getByRole("button", { name: "All tabs" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "All tabs" })).getByRole("button", { name: "Close Server 2" }));
    expect(onClose).toHaveBeenCalledWith("tab-2");
  });

  it("supports tab-arrow navigation and closes menus with Escape", () => {
    const onActive = vi.fn();
    render(
      <TabBar
        tabs={tabs.slice(0, 3)}
        activeTab="tab-1"
        profiles={[]}
        onActive={onActive}
        onClose={vi.fn()}
        onReconnect={vi.fn()}
        language="en"
      />,
    );

    fireEvent.keyDown(screen.getByRole("tab", { name: "Server 1" }), { key: "ArrowRight" });
    expect(onActive).toHaveBeenLastCalledWith("tab-2");

    const allTabs = screen.getByRole("button", { name: "All tabs" });
    fireEvent.click(allTabs);
    expect(screen.getByRole("dialog", { name: "All tabs" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "All tabs" })).not.toBeInTheDocument();
  });

  it("keeps terminal tools and other action menus mutually exclusive", () => {
    render(
      <TabBar
        tabs={tabs.slice(0, 3)}
        activeTab="tab-1"
        profiles={[]}
        onActive={vi.fn()}
        onClose={vi.fn()}
        onReconnect={vi.fn()}
        language="en"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Terminal tools" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All tabs" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "All tabs" })).toBeInTheDocument();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("leaves IME candidate confirmation and cancellation to the input method: %j", (composition) => {
    const onActive = vi.fn();
    render(<TabBar tabs={tabs} activeTab="tab-1" profiles={[]} onActive={onActive} onClose={vi.fn()} onReconnect={vi.fn()} language="zh-CN" />);
    fireEvent.click(screen.getByRole("button", { name: "全部标签" }));
    const dialog = screen.getByRole("dialog", { name: "全部标签" });
    const input = within(dialog).getByRole("textbox");
    input.focus();
    fireEvent.keyDown(input, { key: "Enter", ...composition });
    fireEvent.keyDown(input, { key: "Escape", ...composition });
    fireEvent.keyDown(input, { key: "ArrowDown", ...composition });
    expect(dialog).toBeInTheDocument();
    expect(input).toHaveFocus();
    expect(onActive).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", isComposing: false, keyCode: 13 });
    expect(onActive).toHaveBeenCalledWith("tab-1");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("moves through filtered results with arrows and Home/End without activating until selected", () => {
    const onActive = vi.fn();
    render(<TabBar tabs={tabs} activeTab="tab-1" profiles={[]} onActive={onActive} onClose={vi.fn()} onReconnect={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "All tabs" }));
    const dialog = screen.getByRole("dialog", { name: "All tabs" });
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "Server 1" } });
    const first = within(dialog).getByRole("button", { name: "Server 1" });
    const second = within(dialog).getByRole("button", { name: "Server 10" });
    const last = within(dialog).getByRole("button", { name: "Server 12" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "End" });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Home" });
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowUp" });
    expect(last).toHaveFocus();
    expect(onActive).not.toHaveBeenCalled();
    fireEvent.click(last);
    expect(onActive).toHaveBeenCalledWith("tab-12");
  });

  it("surfaces unread output and exposes rename, pin, and middle-click close actions", () => {
    const tab = { ...tabs[0], unread: true };
    const onClose = vi.fn();
    const onRename = vi.fn();
    const onTogglePin = vi.fn();
    render(
      <TabBar
        tabs={[tab]}
        activeTab="other-tab"
        profiles={[]}
        onActive={vi.fn()}
        onClose={onClose}
        onReconnect={vi.fn()}
        onRename={onRename}
        onTogglePin={onTogglePin}
        language="en"
      />,
    );

    const tabButton = screen.getByRole("tab", { name: "Server 1" });
    const tabElement = tabButton.closest<HTMLElement>(".tab");
    expect(tabElement).not.toBeNull();
    expect(tabElement).toHaveClass("tab-unread");
    expect(within(tabElement as HTMLElement).getByTitle("New output")).toBeInTheDocument();

    fireEvent.contextMenu(tabElement as HTMLElement);
    const contextMenu = screen.getByRole("menu");
    fireEvent.click(within(contextMenu).getByRole("menuitem", { name: "Rename tab" }));
    expect(onRename).toHaveBeenCalledWith(tab);

    fireEvent.contextMenu(tabElement as HTMLElement);
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Pin tab" }));
    expect(onTogglePin).toHaveBeenCalledWith(tab);

    fireEvent.mouseDown(tabElement as HTMLElement, { button: 1 });
    expect(onClose).toHaveBeenCalledWith("tab-1");
  });
});
