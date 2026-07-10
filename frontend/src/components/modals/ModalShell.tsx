import clsx from "clsx";
import { createPortal } from "react-dom";

/**
 * Full-viewport modal shell. Portaled to the app shell so nested sidebar
 * ancestors never clip or re-frame the dialog while theme variables still apply.
 */
export function ModalShell({
  children,
  onClose,
  compact,
  palette,
}: {
  children: React.ReactNode;
  onClose: () => void;
  compact?: boolean;
  /** Command-palette layout: top-centered, no default modal padding. */
  palette?: boolean;
}) {
  if (typeof document === "undefined") return null;

  // Prefer .app-shell so --panel / --border / theme tokens resolve correctly.
  const host =
    document.querySelector(".app-shell") ||
    document.getElementById("root") ||
    document.body;

  return createPortal(
    <div
      className={clsx("modal-backdrop", palette && "modal-backdrop-palette")}
      onMouseDown={onClose}
    >
      <div
        className={clsx(
          "modal",
          compact && "modal-compact",
          palette && "modal-palette",
          palette && compact && "modal-palette-compact",
        )}
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    host,
  );
}

export function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="field-label">
      <span className="field-label-text">{text}</span>
      {children}
    </label>
  );
}

export function DialogHeader({ icon, title, description }: { icon?: React.ReactNode; title: string; description?: string }) {
  return (
    <div className="dialog-header">
      {icon && <span className="dialog-header-icon">{icon}</span>}
      <span className="dialog-header-copy"><strong>{title}</strong>{description && <small>{description}</small>}</span>
    </div>
  );
}
