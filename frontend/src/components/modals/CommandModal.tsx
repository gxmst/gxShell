import { useState } from "react";
import { Save } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ModalShell, Label } from "./ModalShell";

export function CommandModal({ command, onClose, onSave }: { command: types.CommandTemplate; onClose: () => void; onSave: (command: types.CommandTemplate) => void }) {
  const [draft, setDraft] = useState(new types.CommandTemplate(command));
  const update = (patch: any) => setDraft(new types.CommandTemplate({ ...draft, ...patch }));
  return (
    <ModalShell onClose={onClose}>
      <div className="space-y-3">
        <Label text="Name"><input className="input" value={draft.name} onChange={(e) => update({ name: e.target.value })} /></Label>
        <Label text="Category"><input className="input" value={draft.category} onChange={(e) => update({ category: e.target.value })} /></Label>
        <Label text="Command"><textarea className="input min-h-[90px] font-mono" value={draft.command} onChange={(e) => update({ command: e.target.value })} /></Label>
        <Label text="Description"><input className="input" value={draft.description} onChange={(e) => update({ description: e.target.value })} /></Label>
        <button className="btn-primary w-full" onClick={() => onSave(draft)}><Save size={15} /> Save command</button>
      </div>
    </ModalShell>
  );
}

