import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyBackupWorkspaces } from "./backupWorkspaces";
import { WORKSPACES_KEY } from "./workspaces";

const next = JSON.stringify([{ id: "imported", name: "Daily", items: [{ key: "p:one", kind: "profile", target: "one", title: "Server" }], active: "p:one", layout: null, updatedAt: 1 }]);

describe("backup workspace transaction", () => {
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => data.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
      removeItem: vi.fn((key: string) => { data.delete(key); }),
    });
  });

  it("reserves storage before applying native config", async () => {
    const apply = vi.fn(async () => { expect(localStorage.getItem(WORKSPACES_KEY)).toBe(next); });
    const workspaces = await applyBackupWorkspaces(null, next, apply);
    expect(apply).toHaveBeenCalledOnce();
    expect(workspaces[0].id).toBe("imported");
  });

  it("does not apply when browser storage is full", async () => {
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error("quota exceeded"); });
    const apply = vi.fn();
    await expect(applyBackupWorkspaces(null, next, apply)).rejects.toThrow("quota exceeded");
    expect(apply).not.toHaveBeenCalled();
  });

  it.each([null, "[]"])("restores the exact previous value %s on native failure", async (previous) => {
    if (previous !== null) localStorage.setItem(WORKSPACES_KEY, previous);
    await expect(applyBackupWorkspaces(previous, next, async () => { throw new Error("disk failure"); })).rejects.toThrow("disk failure");
    expect(localStorage.getItem(WORKSPACES_KEY)).toBe(previous);
  });

  it("rejects a workspace edit after preview", async () => {
    localStorage.setItem(WORKSPACES_KEY, "[]");
    const apply = vi.fn();
    await expect(applyBackupWorkspaces(null, next, apply)).rejects.toThrow("changed since preview");
    expect(apply).not.toHaveBeenCalled();
  });

  it("reports rollback failure while retaining a concurrent workspace edit", async () => {
    await expect(applyBackupWorkspaces(null, next, async () => {
      localStorage.setItem(WORKSPACES_KEY, "[]");
      throw new Error("native failure");
    })).rejects.toThrow("workspace rollback failed");
    expect(localStorage.getItem(WORKSPACES_KEY)).toBe("[]");
  });
});
