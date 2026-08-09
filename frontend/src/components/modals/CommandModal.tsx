import { useMemo, useRef, useState } from "react";
import { Command, Save } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { DialogHeader, ModalShell, Label } from "./ModalShell";
import { ConfirmDialog } from "./ConfirmDialog";

export function CommandModal({ command, language, onClose, onSave }: { command: types.CommandTemplate; language: string; onClose: () => void; onSave: (command: types.CommandTemplate) => void | Promise<void> }) {
  const lang = language;
  const [draft, setDraft] = useState(new types.CommandTemplate(command));
  const [busy, setBusy] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(new types.CommandTemplate(command)), [command, draft]);
  const update = (patch: any) => setDraft(new types.CommandTemplate({ ...draft, ...patch }));
  const requestClose = () => {
    if (savingRef.current) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };
  const save = async () => {
    if (savingRef.current) return;
    if (!draft.name.trim()) { setError(lang === "zh-CN" ? "命令名称不能为空" : "Command name is required"); return; }
    if (!draft.command.trim()) { setError(lang === "zh-CN" ? "命令内容不能为空" : "Command is required"); return; }
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
    <ModalShell onClose={requestClose} ariaLabel={command.id ? (lang === "zh-CN" ? "编辑命令" : "Edit command") : t(lang, "newCommand")}>
      <DialogHeader icon={<Command size={15} />} title={command.id ? (lang === "zh-CN" ? "编辑命令" : "Edit command") : t(lang, "newCommand")} description={lang === "zh-CN" ? "创建可复用的终端命令模板" : "Create a reusable terminal command template"} />
      <div className="dialog-form">
        <Label text={t(lang, "name")}><input className="input" value={draft.name} onChange={(e) => update({ name: e.target.value })} /></Label>
        <Label text={t(lang, "category")}><input className="input" value={draft.category} onChange={(e) => update({ category: e.target.value })} /></Label>
        <Label text={t(lang, "command")}><textarea className="input min-h-[90px] font-mono" value={draft.command} onChange={(e) => update({ command: e.target.value })} /></Label>
        <Label text={t(lang, "description")}><input className="input" value={draft.description} onChange={(e) => update({ description: e.target.value })} /></Label>
        {error && <div className="profile-modal-error" role="alert">{error}</div>}
        <div className="dialog-footer"><button className="btn-secondary" disabled={busy} onClick={requestClose}>{t(lang, "cancel")}</button><button className="btn-primary" disabled={busy} onClick={save}><Save size={15} /> {busy ? t(lang, "loading") : t(lang, "saveCommand")}</button></div>
      </div>
      {confirmDiscard && <ConfirmDialog locale={lang} title={t(lang, "discardEdits")} body={t(lang, "unsavedChangesHint")} confirmText={lang === "zh-CN" ? "不保存" : "Discard"} onClose={() => setConfirmDiscard(false)} onConfirm={onClose} />}
    </ModalShell>
  );
}
