import { useState } from "react";
import { PencilLine } from "lucide-react";
import { DialogHeader, ModalShell, Label } from "./ModalShell";
import { t } from "../../i18n";

export function TextInputDialog({ title, label, initialValue = "", confirmText, locale = "en", onSubmit, onClose }: { title: string; label: string; initialValue?: string; confirmText?: string; locale?: string; onSubmit: (value: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initialValue);
  return (
    <ModalShell onClose={onClose} compact>
      <DialogHeader icon={<PencilLine size={15} />} title={title} />
      <Label text={label}>
        <input autoFocus className="input" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && value.trim() && onSubmit(value.trim())} />
      </Label>
      <div className="dialog-footer">
        <button className="btn-secondary" onClick={onClose}>{t(locale, "cancel")}</button>
        <button className="btn-primary" disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>{confirmText || t(locale, "save")}</button>
      </div>
    </ModalShell>
  );
}
