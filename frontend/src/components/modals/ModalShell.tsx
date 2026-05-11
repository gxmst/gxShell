import clsx from "clsx";

export function ModalShell({ children, onClose, compact }: { children: React.ReactNode; onClose: () => void; compact?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><div className={clsx("modal", compact && "modal-compact")} onMouseDown={(e) => e.stopPropagation()}>{children}</div></div>;
}

export function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return <label className="block text-xs text-muted"><span className="mb-1 block">{text}</span>{children}</label>;
}

