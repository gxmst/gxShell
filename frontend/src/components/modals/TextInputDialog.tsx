import { useState } from "react";
import { ModalShell, Label } from "./ModalShell";

export function TextInputDialog({ title, label, initialValue = "", confirmText = "Save", onSubmit, onClose }: { title: string; label: string; initialValue?: string; confirmText?: string; onSubmit: (value: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initialValue);
  return (
    <ModalShell onClose={onClose} compact>
      <div className="mb-3 text-sm font-semibold">{title}</div>
      <Label text={label}>
        <input autoFocus className="input" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && value.trim() && onSubmit(value.trim())} />
      </Label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>{confirmText}</button>
      </div>
    </ModalShell>
  );
}

