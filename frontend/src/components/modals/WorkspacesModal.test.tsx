import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { types } from "../../../wailsjs/go/models";
import type { useSessions } from "../../hooks/useSessions";
import { useNamedWorkspaces } from "../../hooks/useNamedWorkspaces";
import { WORKSPACES_KEY } from "../../utils/workspaces";
import { WorkspacesModal } from "./WorkspacesModal";

vi.mock("../../../wailsjs/go/app/App", () => ({ RestoreTextFiles: vi.fn().mockResolvedValue([]) }));
afterEach(() => vi.unstubAllGlobals());

it.each(["double click", "batched clicks"])("keeps the workspace dialog open during restoration after %s", async (interaction) => {
  const workspace = { id: "work", name: "Daily", createdAt: 1, updatedAt: 1, items: [{ key: "p:one", kind: "profile", target: "one", title: "Server" }], active: "p:one" };
  const values = new Map([[WORKSPACES_KEY, JSON.stringify([workspace])]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  const profile = new types.Profile({ id: "one", name: "Server", host: "server.invalid", port: 22, username: "test", authType: "agent" });
  let finish!: (value: string) => void;
  const connect = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
  const sessions = { tabs: [], activeTab: "", beginFocusRequest: () => 1, isFocusRequestCurrent: () => true, setTabs: vi.fn(), finishFocusRequest: vi.fn(), connectWorkspaceProfile: connect } as unknown as ReturnType<typeof useSessions>;
  const onClose = vi.fn();
  function Harness() {
    const manager = useNamedWorkspaces({ sessions, profiles: [profile], floating: [], split: null, setSplit: vi.fn(), dock: vi.fn(), language: "en" });
    return <WorkspacesModal manager={manager} language="en" eligible={0} excluded={0} onClose={onClose} />;
  }
  render(<Harness />);
  const button = screen.getByTitle("Open workspace");
  if (interaction === "double click") await userEvent.setup().dblClick(button);
  else await act(async () => { fireEvent.click(button); fireEvent.click(button); });
  expect(connect).toHaveBeenCalledTimes(1);
  expect(button).toBeDisabled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("Opening:");
  await act(async () => { finish("restored-session"); });
  expect(onClose).toHaveBeenCalledTimes(1);
});
