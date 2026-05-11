import { ModalShell } from "./ModalShell";

export function ConfirmDialog({ title, body, confirmText = "Confirm", onConfirm, onClose }: { title: string; body: string; confirmText?: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <ModalShell onClose={onClose} compact>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-2 text-xs text-muted">{body}</div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-danger" onClick={onConfirm}>{confirmText}</button>
      </div>
    </ModalShell>
  );
}

