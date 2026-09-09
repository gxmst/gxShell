import { describe, expect, it } from "vitest";
import { types } from "../../wailsjs/go/models";
import type { Tab } from "../types";
import { applyWorkspace, captureWorkspace, parseWorkspaces } from "./workspaces";
import { reconcileSplit } from "./splitPane";

const profile = new types.Profile({ id: "server", password: "never persist", privateKeyPassphrase: "also secret" });
const ssh: Tab = { id: "ssh", runtimeId: "profile:server", profileId: "server", title: "Server", state: "connected" };
const doc: Tab = { id: "doc", profileId: "", type: "markdown", markdownSource: "local", filePath: "/notes.md", title: "Notes", state: "connected" };

describe("named workspaces", () => {
  it("persists stable references without credentials or transient terminals", () => {
    const workspace = captureWorkspace("Daily", [ssh, doc, { ...ssh, id: "local", local: true }], [profile], doc.id, null);
    expect(workspace.items.map((i) => i.target)).toEqual(["server", "/notes.md"]);
    expect(JSON.stringify(workspace)).not.toContain("secret");
    expect(JSON.stringify(workspace)).not.toContain("never persist");
    expect(parseWorkspaces(JSON.stringify([workspace]))[0]).toEqual(expect.objectContaining({ name: "Daily", active: "f:/notes.md" }));
  });
  it("keeps existing document identity, unsaved editor state, and unrelated tabs", () => {
    const workspace = captureWorkspace("Daily", [ssh, doc], [profile], doc.id, null);
    const other = { ...doc, id: "other", filePath: "/unsaved.txt" };
    const result = applyWorkspace(workspace, [other, doc, ssh], new Map([[profile.id, ssh.id]]), []);
    expect(result.tabs.map((t) => t.id)).toEqual([ssh.id, doc.id, other.id]);
    expect(result.tabs[1]).toBe(doc);
    expect(result.tabs[2]).toBe(other);
    expect(result.active).toBe(doc.id);
  });
  it("does not open files without a backend grant", () => {
    const workspace = captureWorkspace("Files", [doc], [], doc.id, null);
    expect(applyWorkspace(workspace, [], new Map(), []).tabs).toEqual([]);
    expect(applyWorkspace(workspace, [], new Map(), [doc.filePath!]).tabs).toHaveLength(1);
  });
  it("restores saved server titles and pinning across new session IDs", () => {
    const workspace = captureWorkspace("Daily", [{ ...ssh, title: "Primary DB", customTitle: true, pinned: true }], [profile], ssh.id, null);
    const current = { ...ssh, id: "reconnected" };
    const result = applyWorkspace(workspace, [current], new Map([[profile.id, current.id]]), []);
    expect(result.tabs[0]).toMatchObject({ id: current.id, title: "Primary DB", customTitle: true, pinned: true });
    expect(current.title).toBe("Server");
  });
  it("keeps two instances of one profile as separate workspace items", () => {
    const first = { ...ssh, instanceId: "terminal-a" };
    const second = { ...ssh, id: "ssh-2", instanceId: "terminal-b", title: "Server (2)" };
    const workspace = captureWorkspace("Two shells", [first, second], [profile], first.id, null);
    expect(workspace.items).toHaveLength(2);
    expect(workspace.items.map((item) => item.instanceId)).toEqual(["terminal-a", "terminal-b"]);
    const parsed = parseWorkspaces(JSON.stringify([workspace]))[0];
    expect(parsed.items.map((item) => item.instanceId)).toEqual(["terminal-a", "terminal-b"]);
  });
  it("validates imported layout values and drops missing layout targets", () => {
    const workspace = captureWorkspace("Daily", [ssh, doc], [profile], ssh.id, null);
    const parsed = parseWorkspaces(JSON.stringify([{ ...workspace, layout: { keys: ["missing", "p:server"], ratio: 100 } }]))[0];
    expect(parsed.layout).toBeNull();
  });
  it("remaps reconnect IDs and reduces four panes when one is closed", () => {
    const tabs = [ssh, ...["b", "c", "d"].map((id) => ({ ...ssh, id, runtimeId: `profile:${id}`, profileId: id }))];
    const split = { left: "ssh", right: "b", bottom: ["c", "d"] as [string, string], direction: "grid" as const, ratio: 0.4 };
    expect(reconcileSplit(split, tabs, [{ ...ssh, id: "new" }, ...tabs.slice(1)], [])?.left).toBe("new");
    expect(reconcileSplit(split, tabs, tabs.slice(1), [])).toMatchObject({ left: "b", right: "c", bottom: undefined, direction: "horizontal" });
    expect(reconcileSplit(split, tabs, tabs, ["ssh", "b", "c"])).toBeNull();
  });
});
