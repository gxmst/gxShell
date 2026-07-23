import { AlertTriangle } from "lucide-react";
import { DialogHeader, ModalShell } from "./ModalShell";
import { t } from "../../i18n";

export function ConfirmDialog({ title, body, confirmText, locale = "en", onConfirm, onClose }: { title: string; body: string; confirmText?: string; locale?: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <ModalShell onClose={onClose} compact>
      <DialogHeader icon={<AlertTriangle size={15} />} title={title} />
      <div className="dialog-body-copy">{body}</div>
      <div className="dialog-footer">
        <button className="btn-secondary" onClick={onClose}>{t(locale, "cancel")}</button>
        <button className="btn-danger" onClick={onConfirm}>{confirmText || t(locale, "confirm")}</button>
      </div>
    </ModalShell>
  );
}
