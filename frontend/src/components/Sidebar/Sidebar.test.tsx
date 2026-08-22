import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { types } from "../../../wailsjs/go/models";
import { Sidebar } from "./Sidebar";

vi.mock("../../../wailsjs/go/app/App", () => ({
  PingHost: vi.fn(),
  TraceRoute: vi.fn(),
  UpdateSettings: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../wailsjs/runtime/runtime", () => ({
  EventsOn: vi.fn(() => () => undefined),
  EventsOff: vi.fn(),
}));

const profile = (id: string, extra: Partial<types.Profile> = {}) => new types.Profile({
  id,
  name: id,
  group: "",
  host: `${id}.test`,
  port: 22,
  username: "root",
  authType: "agent",
  rememberPassword: false,
  description: "",
  tags: [],
  favorite: false,
  cliEnabled: false,
  tunnels: [],
  autoReconnect: false,
  ...extra,
});

const profiles = [
  profile("web-1", { group: "Prod", favorite: true, lastConnectedAt: "2026-08-20T10:00:00Z" }),
  profile("web-2", { group: "Prod" }),
  profile("scratch"),
];

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const props = {
    collapsed: false,
    setCollapsed: vi.fn(),
    setCtxMenu: vi.fn(),
    drawer: "monitor" as const,
    setDrawer: vi.fn(),
    profiles,
    commands: [],
    settings: null,
    appInfo: {},
    remotePath: "/",
    remoteFiles: [],
    sftpBusy: false,
    onNewProfile: vi.fn(),
    onQuickConnect: vi.fn(),
    onEditProfile: vi.fn(),
    onConnectProfile: vi.fn(),
    onToggleFavorite: vi.fn(),
    onDeleteProfile: vi.fn(),
    onImportProfiles: vi.fn(),
    onImportOpenSSH: vi.fn(),
    onExportProfiles: vi.fn(),
    onOpenSearch: vi.fn(),
    onStartMonitor: vi.fn(),
    onRefreshSftp: vi.fn(),
    onNotify: vi.fn(),
    onRunCommand: vi.fn(),
    onRunCommandInSession: vi.fn(),
    onRunCommandAll: vi.fn(),
    onEditCommand: vi.fn(),
    onDeleteCommand: vi.fn(),
    onNewCommand: vi.fn(),
    onSaveSettings: vi.fn(),
    onOpenData: vi.fn(),
    onOpenLog: vi.fn(),
    getTerminalLines: vi.fn(() => ""),
    activeTabId: "",
    tabs: [],
    ...overrides,
  };
  return { props, ...render(<Sidebar {...props} />) };
}

describe("Sidebar shell", () => {
  // Regression guard for a refactor that deleted the CSS of the brand row, the
  // nav pill strip and the group tabs while the markup still rendered them. The
  // rail is now the single navigation surface, so those nodes must be gone.
  it("navigates from the activity rail and keeps no second nav surface", () => {
    const { container, props } = renderSidebar();

    const rail = screen.getByRole("navigation");
    expect(within(rail).getAllByRole("button")).toHaveLength(6);
    expect(container.querySelector(".brand-row")).toBeNull();
    expect(container.querySelector(".nav-strip")).toBeNull();
    expect(container.querySelector(".group-tabs")).toBeNull();
    expect(container.querySelector(".drawer-hero")).toBeNull();

    fireEvent.click(within(rail).getByRole("button", { name: "Files" }));
    expect(props.setDrawer).toHaveBeenCalledWith("sftp");
  });

  it("folds the panel when the section already showing is clicked again", () => {
    const { props } = renderSidebar();
    const rail = screen.getByRole("navigation");

    fireEvent.click(within(rail).getByRole("button", { name: "Connect" }));
    expect(props.setCollapsed).toHaveBeenCalledWith(true);
    expect(props.setDrawer).not.toHaveBeenCalled();
  });

  // The rail stays visible while collapsed, which is what makes it possible to
  // come back: clicking a section unfolds instead of switching invisibly.
  it("unfolds when a section is picked while collapsed", () => {
    const { props } = renderSidebar({ collapsed: true });

    fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name: "Tools" }));
    expect(props.setDrawer).toHaveBeenCalledWith("commands");
    expect(props.setCollapsed).toHaveBeenCalledWith(false);
  });

  it("lists every profile under its group with favorites as a shortcut section", () => {
    const { container } = renderSidebar();

    expect(screen.getByText("Servers")).toBeInTheDocument();
    expect(container.querySelector(".panel-head-count")?.textContent).toBe("3");

    const headings = Array.from(container.querySelectorAll(".srv-group-head"))
      .map((node) => node.querySelector(".srv-group-title")?.textContent);
    expect(headings).toEqual(["Favorites", "Recent", "Prod", "Default"]);

    // Recent starts folded because its rows are duplicates of the group rows.
    const recent = container.querySelectorAll(".srv-group")[1];
    expect(recent.querySelectorAll(".server-row")).toHaveLength(0);

    // web-1 shows twice: once as a favorite, once under Prod.
    expect(screen.getAllByText("web-1")).toHaveLength(2);
    expect(screen.getAllByText("web-2")).toHaveLength(1);
  });

  it("folds and unfolds a group from its sticky header", () => {
    const { container } = renderSidebar();
    const prod = container.querySelectorAll(".srv-group")[2];
    const header = prod.querySelector(".srv-group-head") as HTMLElement;

    expect(prod.querySelectorAll(".server-row")).toHaveLength(2);
    expect(header.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(header);
    expect(prod.querySelectorAll(".server-row")).toHaveLength(0);
    expect(header.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(header);
    expect(prod.querySelectorAll(".server-row")).toHaveLength(2);
  });

  it("offers an empty state instead of empty sections when there are no profiles", () => {
    const { container } = renderSidebar({ profiles: [] });

    expect(container.querySelectorAll(".srv-group")).toHaveLength(0);
    expect(container.querySelector(".empty-state")).not.toBeNull();
  });

  // The grip is the panel's trailing edge, so it only exists while there is a
  // panel to size. Collapsed, the rail's own toggle is the way back.
  it("exposes the width grip only when a resize handler is wired and the panel is open", () => {
    const onResizeStart = vi.fn();
    const onResizeReset = vi.fn();

    const bare = renderSidebar();
    expect(bare.container.querySelector(".rail-resizer")).toBeNull();

    const collapsed = renderSidebar({ collapsed: true, onResizeStart, onResizeReset });
    expect(collapsed.container.querySelector(".rail-resizer")).toBeNull();

    const { container } = renderSidebar({ onResizeStart, onResizeReset });
    const grip = container.querySelector(".rail-resizer") as HTMLElement;
    expect(grip).not.toBeNull();
    expect(grip.getAttribute("role")).toBe("separator");
    expect(grip.getAttribute("aria-orientation")).toBe("vertical");

    fireEvent.pointerDown(grip);
    expect(onResizeStart).toHaveBeenCalledTimes(1);

    fireEvent.doubleClick(grip);
    expect(onResizeReset).toHaveBeenCalledTimes(1);
  });
});
