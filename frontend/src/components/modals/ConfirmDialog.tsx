import { AlertTriangle } from "lucide-react";
import { useRef, useState } from "react";
import { DialogHeader, ModalShell } from "./ModalShell";
import { t } from "../../i18n";

export function ConfirmDialog({ title, body, confirmText, locale = "en", onConfirm, onClose }: { title: string; body: string; confirmText?: string; locale?: string; onConfirm: () => void | Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const confirmingRef = useRef(false);

  const confirm = async () => {
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (err) {
      setError(String(err));
    } finally {
      confirmingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={() => { if (!busy) onClose(); }} compact ariaLabel={title}>
      <DialogHeader icon={<AlertTriangle size={15} />} title={title} />
      <div className="dialog-body-copy">{body}</div>
      {error && <div className="profile-modal-error" role="alert">{error}</div>}
      <div className="dialog-footer">
        <button className="btn-secondary" disabled={busy} onClick={onClose}>{t(locale, "cancel")}</button>
        <button className="btn-danger" disabled={busy} onClick={confirm}>{busy ? t(locale, "loading") : (confirmText || t(locale, "confirm"))}</button>
      </div>
    </ModalShell>
  );
}
