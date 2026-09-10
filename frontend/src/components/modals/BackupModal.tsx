import { useEffect, useRef, useState } from "react";
import { Download, ShieldCheck } from "lucide-react";
import { DiscardBackupPreview, ExportBackup, PreviewBackup } from "../../../wailsjs/go/app/App";
import { WORKSPACES_KEY } from "../../utils/workspaces";
import { DialogHeader, Label, ModalShell } from "./ModalShell";

type BackupPreview = {
  token: string;
  createdAt: string;
  profiles: number;
  commands: number;
  workspacesAdded: number;
  skipped: number;
  privateKeys: number;
  namedSecrets: number;
  knownHosts: number;
  settings: boolean;
  workspaces: string;
  warnings: string[];
  changes: { kind: string; name: string; action: string }[];
};

function warningText(value: string, zh: boolean) {
  if (!zh) return value;
  const messages: Record<string, string> = {
    "Private key must be selected again:": "需要重新选择私钥：",
    "External document is unavailable; copy it separately:": "外部文档不可用，请单独复制文件：",
    "External document needs authorization when opened:": "打开外部文档时需要重新授权：",
    "Existing named credential retained:": "保留现有命名凭据：",
    "Existing host key retained:": "保留现有主机指纹：",
    "Special host-key entry requires review:": "特殊主机指纹条目需手动核对：",
    "AI credentials are not included; enter an API key after restoring settings": "备份未包含 AI 凭据；恢复设置后请重新输入 API 密钥。",
  };
  for (const [prefix, translated] of Object.entries(messages)) {
    if (value.startsWith(prefix)) return translated + value.slice(prefix.length);
  }
  return value;
}

export function BackupModal({ mode, language, onClose, onApply, onImported, onExported, onBusyChange }: {
  mode: "export" | "import";
  language: string;
  onClose: () => void;
  onApply: (token: string, previous: string | null, workspaces: string) => Promise<void>;
  onImported: () => void;
  onExported: (path: string) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const zh = language === "zh-CN";
  const exporting = mode === "export";
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [includePrivateKeys, setIncludePrivateKeys] = useState(false);
  const [policy, setPolicy] = useState("keep");
  const [restoreSettings, setRestoreSettings] = useState(true);
  const [preview, setPreview] = useState<{ value: BackupPreview; previous: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const token = useRef("");
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(() => () => {
    if (token.current) void DiscardBackupPreview(token.current).catch(() => undefined);
    busyCallback.current?.(false);
  }, []);

  const close = () => { if (!running.current) onClose(); };
  const clearPreview = () => {
    if (token.current) void DiscardBackupPreview(token.current).catch(() => undefined);
    token.current = "";
    setPreview(null);
  };
  const run = async (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    busyCallback.current?.(true);
    setBusy(true);
    setError("");
    try { await action(); } catch (err) { setError(String(err)); }
    finally { running.current = false; setBusy(false); busyCallback.current?.(false); }
  };
  const prepare = () => run(async () => {
    if ([...passphrase].length < 8) throw new Error(zh ? "备份口令至少需要 8 个字符" : "Use a backup passphrase with at least 8 characters");
    if (exporting && passphrase !== confirmation) throw new Error(zh ? "两次输入的口令不一致" : "The passphrases do not match");
    const previous = localStorage.getItem(WORKSPACES_KEY);
    if (exporting) {
      const path = await ExportBackup(passphrase, previous || "[]", includeSecrets, includePrivateKeys);
      if (path) { setPassphrase(""); setConfirmation(""); onExported(path); onClose(); }
      return;
    }
    const raw = await PreviewBackup(passphrase, previous || "[]", policy, restoreSettings);
    if (!raw) return;
    const value = JSON.parse(raw) as BackupPreview;
    if (!value.token || typeof value.workspaces !== "string") throw new Error("Invalid backup preview");
    token.current = value.token;
    setPreview({ value, previous });
    setPassphrase("");
  });
  const apply = () => run(async () => {
    if (!preview) return;
    try { await onApply(preview.value.token, preview.previous, preview.value.workspaces); }
    catch (err) { clearPreview(); throw err; }
    token.current = "";
    onImported();
    onClose();
  });
  const title = exporting ? (zh ? "导出加密备份" : "Export encrypted backup") : (zh ? "导入加密备份" : "Import encrypted backup");
  const kindNames: Record<string, string> = zh
    ? { profile: "服务器", command: "命令", workspace: "工作区", credential: "凭据" }
    : { profile: "Server", command: "Command", workspace: "Workspace", credential: "Credential" };

  return <ModalShell onClose={close} ariaLabel={title} dismissOnBackdrop={!busy} dismissOnEscape={!busy}>
    <DialogHeader icon={<ShieldCheck size={17} />} title={title} description={zh ? "迁移已保存的服务器、命令、设置、高亮规则、工作区和主机指纹。" : "Transfer saved servers, commands, settings, highlight rules, workspaces and host keys."} />
    <div className="dialog-form backup-form">
      {!preview ? <>
        <Label text={zh ? "备份口令" : "Backup passphrase"}><input type="password" autoComplete={exporting ? "new-password" : "current-password"} className="input" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} /></Label>
        {exporting ? <>
          <Label text={zh ? "确认口令" : "Confirm passphrase"}><input type="password" autoComplete="new-password" className="input" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} /></Label>
          <label className="backup-option"><input type="checkbox" checked={includeSecrets} disabled={busy} onChange={(event) => setIncludeSecrets(event.target.checked)} /><span>{zh ? "包含已保存的密码、私钥口令和 API 凭据" : "Include saved passwords, key passphrases and API credentials"}</span></label>
          <label className="backup-option"><input type="checkbox" checked={includePrivateKeys} disabled={busy} onChange={(event) => setIncludePrivateKeys(event.target.checked)} /><span>{zh ? "包含连接使用的私钥文件" : "Include private key files used by saved connections"}</span></label>
          <p className="backup-hint">{zh ? "口令至少 8 个字符，建议使用较长口令。请妥善保管，忘记口令将无法恢复备份。" : "Use at least 8 characters, preferably a longer passphrase. Keep it safe: a forgotten passphrase cannot be recovered."}</p>
        </> : <>
          <Label text={zh ? "遇到重复项时" : "When items already exist"}><select className="input" value={policy} disabled={busy} onChange={(event) => setPolicy(event.target.value)}><option value="keep">{zh ? "保留现有项" : "Keep existing items"}</option><option value="copy">{zh ? "作为副本导入" : "Import as copies"}</option></select></Label>
          <label className="backup-option"><input type="checkbox" checked={restoreSettings} disabled={busy} onChange={(event) => setRestoreSettings(event.target.checked)} /><span>{zh ? "恢复全局设置和高亮规则" : "Restore global settings and highlight rules"}</span></label>
          <p className="backup-hint">{zh ? "选择文件后先查看内容与冲突，确认后再导入。现有主机指纹和同名凭据优先保留。" : "Choose a file, review its contents and conflicts, then apply. Existing host keys and named credentials take precedence."}</p>
        </>}
        <p className="backup-hint">{zh ? "外部文档需单独复制；工作区会保留路径。CLI 临时信任和本机文件授权需要重新设置。" : "Copy external documents separately; workspaces retain their paths. CLI trust and local file access must be granted again."}</p>
      </> : <>
        <p className="backup-hint">{zh ? "备份时间：" : "Backup created: "}{new Date(preview.value.createdAt).toLocaleString(language)}</p>
        <dl className="backup-summary">
          {[
            [zh ? "新增服务器" : "Servers added", preview.value.profiles],
            [zh ? "新增命令" : "Commands added", preview.value.commands],
            [zh ? "新增工作区" : "Workspaces added", preview.value.workspacesAdded],
            [zh ? "保留现有项" : "Existing items kept", preview.value.skipped],
            [zh ? "私钥文件" : "Private key files", preview.value.privateKeys],
            [zh ? "命名凭据" : "Named credentials", preview.value.namedSecrets],
            [zh ? "新增主机指纹" : "Host keys added", preview.value.knownHosts],
            [zh ? "恢复设置" : "Restore settings", preview.value.settings ? (zh ? "是" : "Yes") : (zh ? "否" : "No")],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        {!!preview.value.changes?.length && <details open className="backup-details"><summary>{zh ? "内容与冲突" : "Contents and conflicts"}</summary><ul>{preview.value.changes.map((change, index) => <li key={index}><span>{kindNames[change.kind] || change.kind} · {change.name}</span><strong>{change.action === "keep" ? (zh ? "保留现有" : "Keep existing") : (zh ? "新增" : "Add")}</strong></li>)}</ul></details>}
        {!!preview.value.warnings?.length && <details open className="backup-details backup-warnings"><summary>{zh ? "需要注意的项目" : "Items to review"}</summary><ul>{preview.value.warnings.map((warning, index) => <li key={index}>{warningText(warning, zh)}</li>)}</ul></details>}
      </>}
      {error && <div className="profile-modal-error" role="alert">{error}</div>}
      <div className="dialog-footer"><button className="btn-secondary" disabled={busy} onClick={close}>{zh ? "取消" : "Cancel"}</button>{preview && <button className="btn-secondary" disabled={busy} onClick={clearPreview}>{zh ? "重新选择" : "Choose again"}</button>}<button className="btn-primary" disabled={busy} onClick={preview ? apply : prepare}><Download size={14} />{busy ? (zh ? "处理中…" : "Working…") : preview ? (zh ? "确认导入" : "Apply backup") : exporting ? (zh ? "导出备份" : "Export backup") : (zh ? "选择文件并预览" : "Choose file and preview")}</button></div>
    </div>
  </ModalShell>;
}
