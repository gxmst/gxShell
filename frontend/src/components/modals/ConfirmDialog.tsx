import { ModalShell } from "./ModalShell";
import { t } from "../../i18n";

export function ConfirmDialog({ title, body, confirmText, locale = "en", onConfirm, onClose }: { title: string; body: string; confirmText?: string; locale?: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <ModalShell onClose={onClose} compact>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-2 text-xs text-muted">{body}</div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>{t(locale, "cancel")}</button>
        <button className="btn-danger" onClick={onConfirm}>{confirmText || t(locale, "confirm")}</button>
      </div>
    </ModalShell>
  );
}
