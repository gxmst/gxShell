import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { DeleteNamedSecret, ListNamedSecrets, SaveNamedSecret, type NamedSecret } from "../../../wailsjs/go/app/App";
import { DialogHeader, Label, ModalShell } from "../modals/ModalShell";
import { t } from "../../i18n";
import { isImeComposing } from "../../utils/ime";

function SecretEditor({ alias, language, onSaved, onClose }: { alias: string | null; language: string; onSaved: () => void; onClose: () => void }) {
  const [name, setName] = useState(alias || "");
  // Keep the manually entered value out of settings, React state and attributes.
  // It exists only in the masked input until passed to the native save boundary.
  const valueRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const title = t(language, alias === null ? "secretAdd" : "secretReplace");
  const close = () => {
    if (busy) return;
    if (valueRef.current) valueRef.current.value = "";
    onClose();
  };
  const save = async () => {
    if (busy) return;
    const normalized = name.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)) {
      setError(t(language, "secretInvalidAlias"));
      return;
    }
    const input = valueRef.current;
    if (!input || !input.value || input.value.length > 65536 || /[\r\n\u0000]/.test(input.value)) {
      setError(t(language, "secretInvalidValue"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await SaveNamedSecret(normalized, input.value, alias !== null);
      input.value = "";
      onSaved();
    } catch {
      // Never display a raw backend/bridge error that could contain the value.
      setError(t(language, "secretSaveFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalShell compact ariaLabel={title} onClose={close} dismissOnBackdrop={false} dismissOnEscape={!busy}>
      <DialogHeader icon={<KeyRound size={15} />} title={title} description={t(language, "secretEntryHint")} />
      <div className="space-y-3" onKeyDown={(event) => {
        if (event.key === "Enter" && !isImeComposing(event)) { event.preventDefault(); void save(); }
      }}>
        <Label text={t(language, "secretAlias")}>
          <input className="input" value={name} disabled={busy || alias !== null} maxLength={64} autoComplete="off" spellCheck={false} placeholder="teldrive-api-hash" onChange={(event) => setName(event.target.value)} />
        </Label>
        <Label text={t(language, "secretValue")}>
          <input ref={valueRef} className="input named-secret-value" type="password" disabled={busy} maxLength={65536} autoComplete="new-password" spellCheck={false} />
        </Label>
        {alias !== null && <p className="settings-field-hint">{t(language, "secretReplaceHint")}</p>}
        {error && <div className="profile-modal-error" role="alert">{error}</div>}
      </div>
      <div className="dialog-footer">
        <button className="btn-secondary" disabled={busy} onClick={close}>{t(language, "cancel")}</button>
        <button className="btn-primary" disabled={busy} onClick={() => void save()}>{t(language, "secretSave")}</button>
      </div>
    </ModalShell>
  );
}

export function NamedSecretsManager({ language, onNotify }: { language: string; onNotify?: (text: string, tone?: "info" | "error" | "success") => void }) {
  const [entries, setEntries] = useState<NamedSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editor, setEditor] = useState<{ alias: string | null } | null>(null);
  const [deleting, setDeleting] = useState<NamedSecret | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try { setEntries(await ListNamedSecrets() || []); }
    catch { setLoadFailed(true); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const copy = async (reference: string) => {
    try { await navigator.clipboard.writeText(reference); onNotify?.(t(language, "secretCopied"), "success"); }
    catch { onNotify?.(t(language, "secretCopyFailed"), "error"); }
  };
  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    setDeleteFailed(false);
    try {
      await DeleteNamedSecret(deleting.alias);
      setDeleting(null);
      onNotify?.(t(language, "secretDeleted"), "success");
      await load();
    } catch { setDeleteFailed(true); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-3">
      <div className="settings-action-grid">
        <button className="btn-secondary" disabled={loading || loadFailed} onClick={() => setEditor({ alias: null })}><Plus size={13} /> {t(language, "secretAdd")}</button>
        <button className="btn-secondary" disabled={loading} onClick={() => void load()}><RefreshCw size={13} /> {t(language, "refresh")}</button>
      </div>
      <p className="settings-field-hint">{t(language, "secretUsageHint")}</p>
      {loading && <p className="settings-field-hint">{t(language, "loading")}</p>}
      {loadFailed && <div className="profile-modal-error" role="alert">{t(language, "secretListFailed")}</div>}
      {!loading && !loadFailed && entries.length === 0 && <p className="settings-field-hint">{t(language, "secretEmpty")}</p>}
      {!loading && !loadFailed && entries.map((entry) => (
        <div key={entry.alias} className="named-secret-row">
          <div className="named-secret-copy"><strong title={entry.alias}>{entry.alias}</strong><code title={entry.reference}>{entry.reference}</code></div>
          <div className="named-secret-actions">
            <button className="icon-btn compact-icon" aria-label={t(language, "secretCopy")} title={t(language, "secretCopy")} onClick={() => void copy(entry.reference)}><Copy size={12} /></button>
            <button className="icon-btn compact-icon" aria-label={t(language, "secretReplace")} title={t(language, "secretReplace")} onClick={() => setEditor({ alias: entry.alias })}><KeyRound size={12} /></button>
            <button className="icon-btn compact-icon text-bad" aria-label={t(language, "secretDelete")} title={t(language, "secretDelete")} onClick={() => { setDeleteFailed(false); setDeleting(entry); }}><Trash2 size={12} /></button>
          </div>
        </div>
      ))}
      {editor && <SecretEditor alias={editor.alias} language={language} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); onNotify?.(t(language, "secretSaved"), "success"); void load(); }} />}
      {deleting && <ModalShell compact ariaLabel={t(language, "secretDelete")} onClose={() => { if (!busy) setDeleting(null); }} dismissOnBackdrop={false} dismissOnEscape={!busy}>
        <DialogHeader icon={<Trash2 size={15} />} title={t(language, "secretDelete")} description={deleting.reference} />
        <p className="settings-field-hint">{t(language, "secretDeleteHint")}</p>
        {deleteFailed && <div className="profile-modal-error" role="alert">{t(language, "secretDeleteFailed")}</div>}
        <div className="dialog-footer">
          <button className="btn-secondary" disabled={busy} onClick={() => setDeleting(null)}>{t(language, "cancel")}</button>
          <button className="btn-primary" disabled={busy} onClick={() => void remove()}>{t(language, "secretDelete")}</button>
        </div>
      </ModalShell>}
    </div>
  );
}
