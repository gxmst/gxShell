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
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(12);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Server 12" }));
    expect(onActive).toHaveBeenLastCalledWith("tab-12");

    fireEvent.click(screen.getByRole("button", { name: "All tabs" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("button", { name: "Close Server 2" }));
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
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
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
