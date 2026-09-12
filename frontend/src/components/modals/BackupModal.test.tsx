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

function setup(mode: "export" | "import", onApply = vi.fn(async () => undefined), language = "en") {
  const callbacks = { onApply, onClose: vi.fn(), onImported: vi.fn(), onExported: vi.fn() };
  const view = render(<BackupModal mode={mode} language={language} {...callbacks} />);
  return { ...callbacks, ...view };
}

describe("encrypted backup dialog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null) });
    vi.mocked(DiscardBackupPreview).mockResolvedValue(undefined);
    vi.mocked(PreviewBackup).mockResolvedValue(JSON.stringify(preview));
    vi.mocked(ExportBackup).mockResolvedValue({ path: "test-backup.gxbak", warnings: [] });
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
    expect(view.onClose).toHaveBeenCalledOnce();
  });

  it.each([
    { language: "en", exportButton: "Export backup", done: "Encrypted backup exported", warning: "Deleted workspace server skipped: Daily / Old server", close: "Close" },
    { language: "zh-CN", exportButton: "导出备份", done: "加密备份已导出", warning: "已跳过工作区中已删除的服务器：Daily / Old server", close: "关闭" },
  ])("keeps export omissions visible in $language without exporting again", async ({ language, exportButton, done, warning, close }) => {
    vi.mocked(ExportBackup).mockResolvedValue({
      path: "test-backup.gxbak",
      warnings: ["Deleted workspace server skipped: Daily / Old server", "Empty workspace skipped: Obsolete"],
    });
    const view = setup("export", undefined, language);
    for (const input of screen.getByRole("dialog").querySelectorAll('input[type="password"]')) {
      fireEvent.change(input, { target: { value: "test passphrase" } });
    }
    fireEvent.click(screen.getByRole("button", { name: exportButton }));
    expect(await screen.findByRole("status")).toHaveTextContent(done);
    expect(screen.getByText(warning)).toBeInTheDocument();
    expect(screen.getByText("test-backup.gxbak")).toBeInTheDocument();
    expect(view.onExported).toHaveBeenCalledOnce();
    expect(view.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").querySelector('input[type="password"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: close }));
    expect(view.onClose).toHaveBeenCalledOnce();
    expect(ExportBackup).toHaveBeenCalledOnce();
  });

  it("keeps the form open when the native export dialog is cancelled", async () => {
    vi.mocked(ExportBackup).mockResolvedValue({ path: "", warnings: [] });
    const view = setup("export");
    for (const input of screen.getByRole("dialog").querySelectorAll('input[type="password"]')) {
      fireEvent.change(input, { target: { value: "test passphrase" } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Export backup" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Export backup" })).toBeEnabled());
    expect(view.onExported).not.toHaveBeenCalled();
    expect(view.onClose).not.toHaveBeenCalled();
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

  it.each([
    { language: "en", choose: "Choose file and preview", title: "AI configuration will change" },
    { language: "zh-CN", choose: "选择文件并预览", title: "AI 配置将发生变化" },
  ])("shows old and new AI destinations before applying in $language", async ({ language, choose, title }) => {
    vi.mocked(PreviewBackup).mockResolvedValue(JSON.stringify({ ...preview, aiChanges: [
      { field: "provider", before: "openai", after: "custom" },
      { field: "endpoint", before: "https://current.invalid/v1", after: "https://imported.invalid/v1" },
      { field: "model", before: "old-model", after: "new-model" },
    ] }));
    const view = setup("import", undefined, language);
    fireEvent.change(screen.getByRole("dialog").querySelector('input[type="password"]')!, { target: { value: "test passphrase" } });
    fireEvent.click(screen.getByRole("button", { name: choose }));
    const changes = await screen.findByRole("table", { name: title });
    expect(changes).toHaveTextContent("https://current.invalid/v1");
    expect(changes).toHaveTextContent("https://imported.invalid/v1");
    expect(changes).toHaveTextContent("old-model");
    expect(changes).toHaveTextContent("new-model");
    expect(view.onApply).not.toHaveBeenCalled();
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
