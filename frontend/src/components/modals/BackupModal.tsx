import { useEffect, useRef, useState } from "react";
import { Download, ShieldCheck } from "lucide-react";
import { DiscardBackupPreview, ExportBackup, PreviewBackup } from "../../../wailsjs/go/app/App";
import type { types } from "../../../wailsjs/go/models";
import { t, type LangKey } from "../../i18n";
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
  aiChanges?: { field: "provider" | "endpoint" | "model"; before: string; after: string }[];
  workspaces: string;
  warnings: string[];
  changes: { kind: string; name: string; action: string }[];
};

function warningText(value: string, language: string) {
  const messages: Record<string, LangKey> = {
    "Private key must be selected again:": "backupWarningPrivateKey",
    "External document is unavailable; copy it separately:": "backupWarningUnavailableFile",
    "External document needs authorization when opened:": "backupWarningFileAuthorization",
    "Existing named credential retained:": "backupWarningExistingCredential",
    "Existing host key retained:": "backupWarningExistingHostKey",
    "Special host-key entry requires review:": "backupWarningSpecialHostKey",
    "AI credentials are not included; enter an API key after restoring settings": "backupWarningAiCredentials",
    "Deleted workspace server skipped:": "backupSkippedWorkspaceServer",
    "Empty workspace skipped:": "backupSkippedEmptyWorkspace",
  };
  for (const [prefix, key] of Object.entries(messages)) {
    if (value.startsWith(prefix)) {
      const suffix = value.slice(prefix.length).trimStart();
      return t(language, key) + (suffix && language !== "zh-CN" ? " " : "") + suffix;
    }
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
  const exporting = mode === "export";
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [includePrivateKeys, setIncludePrivateKeys] = useState(false);
  const [policy, setPolicy] = useState("keep");
  const [restoreSettings, setRestoreSettings] = useState(true);
  const [preview, setPreview] = useState<{ value: BackupPreview; previous: string | null } | null>(null);
  const [exported, setExported] = useState<types.BackupExportResult | null>(null);
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
    if ([...passphrase].length < 8) throw new Error(t(language, "backupPassphraseMinimum"));
    if (exporting && passphrase !== confirmation) throw new Error(t(language, "backupPassphraseMismatch"));
    const previous = localStorage.getItem(WORKSPACES_KEY);
    if (exporting) {
      const result = await ExportBackup(passphrase, previous || "[]", includeSecrets, includePrivateKeys);
      if (result.path) {
        setPassphrase("");
        setConfirmation("");
        onExported(result.path);
        if (result.warnings?.length) setExported(result);
        else onClose();
      }
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
  const title = exporting ? (t(language, "backupExportTitle")) : (t(language, "backupImportTitle"));
  const kindNames: Record<string, string> = {
    profile: t(language, "backupKindServer"), command: t(language, "backupKindCommand"),
    workspace: t(language, "backupKindWorkspace"), credential: t(language, "backupKindCredential"),
  };
  const aiLabels = { provider: "aiProvider", endpoint: "aiEndpoint", model: "aiModel" } as const;

  return <ModalShell onClose={close} ariaLabel={title} dismissOnBackdrop={!busy} dismissOnEscape={!busy}>
    <DialogHeader icon={<ShieldCheck size={17} />} title={title} description={t(language, "backupDescription")} />
    <div className="dialog-form backup-form">
      {exported ? <>
        <p role="status">{t(language, "backupExportCompleted")}</p>
        <p className="backup-hint">{exported.path}</p>
        <div className="backup-details backup-warnings">
          <p className="backup-hint">{t(language, "backupExportSkippedHint")}</p>
          <ul>{exported.warnings.map((warning, index) => <li key={index}>{warningText(warning, language)}</li>)}</ul>
        </div>
      </> : !preview ? <>
        <Label text={t(language, "backupPassphrase")}><input type="password" autoComplete={exporting ? "new-password" : "current-password"} className="input" value={passphrase} disabled={busy} onChange={(event) => setPassphrase(event.target.value)} /></Label>
        {exporting ? <>
          <Label text={t(language, "backupConfirmPassphrase")}><input type="password" autoComplete="new-password" className="input" value={confirmation} disabled={busy} onChange={(event) => setConfirmation(event.target.value)} /></Label>
          <label className="backup-option"><input type="checkbox" checked={includeSecrets} disabled={busy} onChange={(event) => setIncludeSecrets(event.target.checked)} /><span>{t(language, "backupIncludeCredentials")}</span></label>
          <label className="backup-option"><input type="checkbox" checked={includePrivateKeys} disabled={busy} onChange={(event) => setIncludePrivateKeys(event.target.checked)} /><span>{t(language, "backupIncludePrivateKeys")}</span></label>
          <p className="backup-hint">{t(language, "backupPassphraseHint")}</p>
          <p className="backup-hint">{t(language, "backupExportWorkspaceHint")}</p>
        </> : <>
          <Label text={t(language, "backupConflictPolicy")}><select className="input" value={policy} disabled={busy} onChange={(event) => setPolicy(event.target.value)}><option value="keep">{t(language, "backupKeepExisting")}</option><option value="copy">{t(language, "backupImportCopies")}</option></select></Label>
          <label className="backup-option"><input type="checkbox" checked={restoreSettings} disabled={busy} onChange={(event) => setRestoreSettings(event.target.checked)} /><span>{t(language, "backupRestoreSettingsOption")}</span></label>
          <p className="backup-hint">{t(language, "backupImportHint")}</p>
        </>}
        <p className="backup-hint">{t(language, "backupExternalFilesHint")}</p>
      </> : <>
        <p className="backup-hint">{t(language, "backupCreatedAt")}{new Date(preview.value.createdAt).toLocaleString(language)}</p>
        <dl className="backup-summary">
          {[
            [t(language, "backupAddedServers"), preview.value.profiles],
            [t(language, "backupAddedCommands"), preview.value.commands],
            [t(language, "backupAddedWorkspaces"), preview.value.workspacesAdded],
            [t(language, "backupKeptItems"), preview.value.skipped],
            [t(language, "backupPrivateKeys"), preview.value.privateKeys],
            [t(language, "backupNamedCredentials"), preview.value.namedSecrets],
            [t(language, "backupAddedHostKeys"), preview.value.knownHosts],
            [t(language, "backupRestoreSettings"), preview.value.settings ? (t(language, "backupYes")) : (t(language, "backupNo"))],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
        {!!preview.value.aiChanges?.length && <section className="backup-ai-changes">
          <strong>{t(language, "backupAiChanges")}</strong>
          <p className="backup-hint">{t(language, "backupAiChangesHint")}</p>
          <table aria-label={t(language, "backupAiChanges")}>
            <thead><tr><th scope="col">{t(language, "backupSetting")}</th><th scope="col">{t(language, "backupBefore")}</th><th scope="col">{t(language, "backupAfter")}</th></tr></thead>
            <tbody>{preview.value.aiChanges.map((change) => <tr key={change.field}>
              <th scope="row">{t(language, aiLabels[change.field])}</th>
              <td>{change.before || t(language, change.field === "endpoint" ? "backupDefaultEndpoint" : "backupNotConfigured")}</td>
              <td>{change.after || t(language, change.field === "endpoint" ? "backupDefaultEndpoint" : "backupNotConfigured")}</td>
            </tr>)}</tbody>
          </table>
        </section>}
        {!!preview.value.changes?.length && <details open className="backup-details"><summary>{t(language, "backupContents")}</summary><ul>{preview.value.changes.map((change, index) => <li key={index}><span>{kindNames[change.kind] || change.kind} · {change.name}</span><strong>{change.action === "keep" ? (t(language, "backupKeep")) : (t(language, "backupAdd"))}</strong></li>)}</ul></details>}
        {!!preview.value.warnings?.length && <details open className="backup-details backup-warnings"><summary>{t(language, "backupWarnings")}</summary><ul>{preview.value.warnings.map((warning, index) => <li key={index}>{warningText(warning, language)}</li>)}</ul></details>}
      </>}
      {error && <div className="profile-modal-error" role="alert">{error}</div>}
      <div className="dialog-footer">
        {exported ? <button className="btn-primary" disabled={busy} onClick={close}>{t(language, "close")}</button> : <>
          <button className="btn-secondary" disabled={busy} onClick={close}>{t(language, "backupCancel")}</button>
          {preview && <button className="btn-secondary" disabled={busy} onClick={clearPreview}>{t(language, "backupChooseAgain")}</button>}
          <button className="btn-primary" disabled={busy} onClick={preview ? apply : prepare}><Download size={14} />{busy ? (t(language, "backupWorking")) : preview ? (t(language, "backupApply")) : exporting ? (t(language, "backupExport")) : (t(language, "backupChooseFile"))}</button>
        </>}
      </div>
    </div>
  </ModalShell>;
}
