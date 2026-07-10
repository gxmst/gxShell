import { useState } from "react";
import { Command, Save } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { DialogHeader, ModalShell, Label } from "./ModalShell";

export function CommandModal({ command, language, onClose, onSave }: { command: types.CommandTemplate; language: string; onClose: () => void; onSave: (command: types.CommandTemplate) => void }) {
  const lang = language;
  const [draft, setDraft] = useState(new types.CommandTemplate(command));
  const update = (patch: any) => setDraft(new types.CommandTemplate({ ...draft, ...patch }));
  return (
    <ModalShell onClose={onClose}>
      <DialogHeader icon={<Command size={15} />} title={command.id ? (lang === "zh-CN" ? "编辑命令" : "Edit command") : t(lang, "newCommand")} description={lang === "zh-CN" ? "创建可复用的终端命令模板" : "Create a reusable terminal command template"} />
      <div className="dialog-form">
        <Label text={t(lang, "name")}><input className="input" value={draft.name} onChange={(e) => update({ name: e.target.value })} /></Label>
        <Label text={t(lang, "category")}><input className="input" value={draft.category} onChange={(e) => update({ category: e.target.value })} /></Label>
        <Label text={t(lang, "command")}><textarea className="input min-h-[90px] font-mono" value={draft.command} onChange={(e) => update({ command: e.target.value })} /></Label>
        <Label text={t(lang, "description")}><input className="input" value={draft.description} onChange={(e) => update({ description: e.target.value })} /></Label>
        <div className="dialog-footer"><button className="btn-secondary" onClick={onClose}>{t(lang, "cancel")}</button><button className="btn-primary" onClick={() => onSave(draft)}><Save size={15} /> {t(lang, "saveCommand")}</button></div>
      </div>
    </ModalShell>
  );
}
