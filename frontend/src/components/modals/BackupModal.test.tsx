import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscardBackupPreview, ExportBackup, PreviewBackup } from "../../../wailsjs/go/app/App";
import { BackupModal } from "./BackupModal";

vi.mock("../../../wailsjs/go/app/App", () => ({ ExportBackup: vi.fn(), PreviewBackup: vi.fn(), DiscardBackupPreview: vi.fn() }));

const preview = {
  token: "preview-token", createdAt: "2026-09-10T00:00:00Z", profiles: 1, commands: 2, workspacesAdded: 1,
  skipped: 1, privateKeys: 0, namedSecrets: 0, knownHosts: 1, settings: true, workspaces: "[]",
  warnings: ["Private key must be selected again: Legacy"],
  changes: [{ kind: "profile", name: "Server", action: "add" }, { kind: "profile", name: "Existing", action: "keep" }],
};

function setup(mode: "export" | "import", onApply = vi.fn(async () => undefined)) {
  const callbacks = { onApply, onClose: vi.fn(), onImported: vi.fn(), onExported: vi.fn() };
  const view = render(<BackupModal mode={mode} language="en" {...callbacks} />);
  return { ...callbacks, ...view };
}

describe("encrypted backup dialog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null) });
    vi.mocked(DiscardBackupPreview).mockResolvedValue(undefined);
    vi.mocked(PreviewBackup).mockResolvedValue(JSON.stringify(preview));
    vi.mocked(ExportBackup).mockResolvedValue("test-backup.gxbak");
  });

  it("masks the passphrase, verifies confirmation and keeps secrets opt-in", async () => {
    const view = setup("export");
    const passphrase = screen.getByLabelText("Backup passphrase");
    expect(passphrase.getAttribute("type")).toBe("password");
    fireEvent.change(passphrase, { target: { value: "test passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Export backup" }));
    await screen.findByRole("alert");
    expect(ExportBackup).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: "test passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Export backup" }));
    await waitFor(() => expect(ExportBackup).toHaveBeenCalledWith("test passphrase", "[]", false, false));
    expect(view.onExported).toHaveBeenCalledWith("test-backup.gxbak");
  });

  it("previews conflicts before allowing import and discards the token when closed", async () => {
    const view = setup("import");
    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: "test passphrase" } });
    fireEvent.change(screen.getByLabelText("When items already exist"), { target: { value: "copy" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose file and preview" }));
    await screen.findByText("Server · Existing");
    expect(PreviewBackup).toHaveBeenCalledWith("test passphrase", "[]", "copy", true);
    expect(view.onApply).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Backup passphrase")).toBeNull();
    view.unmount();
    expect(DiscardBackupPreview).toHaveBeenCalledWith("preview-token");
  });

  it("applies only the reviewed token and original workspace snapshot", async () => {
    const view = setup("import");
    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: "test passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose file and preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply backup" }));
    await waitFor(() => expect(view.onImported).toHaveBeenCalledOnce());
    expect(view.onApply).toHaveBeenCalledWith("preview-token", null, "[]");
    view.unmount();
    expect(DiscardBackupPreview).not.toHaveBeenCalled();
  });

  it("returns to preview selection after a failed import without reporting success", async () => {
    const onApply = vi.fn(async () => { throw new Error("data changed since preview"); });
    const view = setup("import", onApply);
    fireEvent.change(screen.getByLabelText("Backup passphrase"), { target: { value: "test passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose file and preview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply backup" }));
    expect((await screen.findByRole("alert")).textContent).toContain("data changed since preview");
    expect(screen.getByLabelText("Backup passphrase")).toHaveValue("");
    expect(view.onImported).not.toHaveBeenCalled();
    expect(DiscardBackupPreview).toHaveBeenCalledWith("preview-token");
  });
});
