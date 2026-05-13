import { useState } from "react";
import { Save } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { ModalShell, Label } from "./ModalShell";

export function CommandModal({ command, language, onClose, onSave }: { command: types.CommandTemplate; language: string; onClose: () => void; onSave: (command: types.CommandTemplate) => void }) {
  const lang = language;
  const [draft, setDraft] = useState(new types.CommandTemplate(command));
  const update = (patch: any) => setDraft(new types.CommandTemplate({ ...draft, ...patch }));
  return (
    <ModalShell onClose={onClose}>
      <div className="space-y-3">
        <Label text={t(lang, "name")}><input className="input" value={draft.name} onChange={(e) => update({ name: e.target.value })} /></Label>
        <Label text={t(lang, "category")}><input className="input" value={draft.category} onChange={(e) => update({ category: e.target.value })} /></Label>
        <Label text={t(lang, "command")}><textarea className="input min-h-[90px] font-mono" value={draft.command} onChange={(e) => update({ command: e.target.value })} /></Label>
        <Label text={t(lang, "description")}><input className="input" value={draft.description} onChange={(e) => update({ description: e.target.value })} /></Label>
        <button className="btn-primary w-full" onClick={() => onSave(draft)}><Save size={15} /> {t(lang, "saveCommand")}</button>
      </div>
    </ModalShell>
  );
}

