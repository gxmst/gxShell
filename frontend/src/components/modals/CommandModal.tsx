import { useEffect, useMemo, useRef, useState } from "react";
import { Command, Save } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { DialogHeader, ModalShell, Label } from "./ModalShell";
import { ConfirmDialog } from "./ConfirmDialog";

export function CommandModal({ command, language, onClose, onSave, onDirtyChange }: { command: types.CommandTemplate; language: string; onClose: () => void; onSave: (command: types.CommandTemplate) => void | Promise<void>; onDirtyChange?: (dirty: boolean) => void }) {
  const lang = language;
  const [draft, setDraft] = useState(new types.CommandTemplate(command));
  const [busy, setBusy] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(new types.CommandTemplate(command)), [command, draft]);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => () => onDirtyChangeRef.current?.(false), []);
  const update = (patch: any) => setDraft(new types.CommandTemplate({ ...draft, ...patch }));
  const requestClose = () => {
    if (savingRef.current) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const save = async () => {
    if (savingRef.current) return;
    if (!draft.name.trim()) { setError(t(lang, "commandNameRequired")); return; }
    if (!draft.command.trim()) { setError(t(lang, "commandRequired")); return; }
    savingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onSave(draft);
    } catch (err) {
      setError(String(err));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };
  return (
    <ModalShell onClose={requestClose} ariaLabel={command.id ? t(lang, "editCommand") : t(lang, "newCommand")}>
      <DialogHeader icon={<Command size={15} />} title={command.id ? t(lang, "editCommand") : t(lang, "newCommand")} description={t(lang, "newCommandHint")} />
      <div className="dialog-form">
        <Label text={t(lang, "name")}><input className="input" value={draft.name} onChange={(e) => update({ name: e.target.value })} /></Label>
        <Label text={t(lang, "category")}><input className="input" value={draft.category} onChange={(e) => update({ category: e.target.value })} /></Label>
        <Label text={t(lang, "command")}><textarea className="input min-h-[90px] font-mono" value={draft.command} onChange={(e) => update({ command: e.target.value })} /></Label>
        <Label text={t(lang, "description")}><input className="input" value={draft.description} onChange={(e) => update({ description: e.target.value })} /></Label>
        {error && <div className="profile-modal-error" role="alert">{error}</div>}
        <div className="dialog-footer"><button className="btn-secondary" disabled={busy} onClick={requestClose}>{t(lang, "cancel")}</button><button className="btn-primary" disabled={busy} onClick={save}><Save size={15} /> {busy ? t(lang, "loading") : t(lang, "saveCommand")}</button></div>
      </div>
      {confirmDiscard && <ConfirmDialog locale={lang} title={t(lang, "discardEdits")} body={t(lang, "unsavedChangesHint")} confirmText={t(lang, "discardNoSave")} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} />}
    </ModalShell>
  );
}
