import clsx from "clsx";
import { createPortal } from "react-dom";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  getActiveOverlayId,
  getOverlayLayer,
  getOverlayRevision,
  hasActiveOverlay,
  registerOverlay,
  subscribeOverlays,
} from "../../utils/overlayManager";

let overlaySequence = 0;

/**
 * Full-viewport modal shell. Portaled to the app shell so nested sidebar
 * ancestors never clip or re-frame the dialog while theme variables still apply.
 */
export function ModalShell({
  children,
  onClose,
  compact,
  palette,
  ariaLabel,
  priority = 0,
  dismissOnBackdrop = true,
  dismissOnEscape = true,
}: {
  children: React.ReactNode;
  onClose: () => void;
  compact?: boolean;
  /** Command-palette layout: top-centered, no default modal padding. */
  palette?: boolean;
  ariaLabel?: string;
  /** Higher-priority dialogs own focus even if several workflows overlap. */
  priority?: number;
  dismissOnBackdrop?: boolean;
  dismissOnEscape?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Keep the focus origin for the lifetime of this shell. A nested overlay
  // temporarily revokes ownership; when ownership returns, capturing the
  // then-active element would overwrite the original terminal/button and make
  // closing the outer dialog restore focus to a detached inner dialog.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const overlayIdRef = useRef("");
  if (!overlayIdRef.current) overlayIdRef.current = `gx-overlay-${++overlaySequence}`;
  const overlayId = overlayIdRef.current;
  useSyncExternalStore(subscribeOverlays, getOverlayRevision, getOverlayRevision);
  const activeOverlayId = getActiveOverlayId();
  const ownsFocus = !activeOverlayId || activeOverlayId === overlayId;

  useEffect(() => registerOverlay(overlayId, priority), [overlayId, priority]);

  useEffect(() => {
    if (!ownsFocus) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (restoreFocusRef.current === null) restoreFocusRef.current = previouslyFocused;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");

    // `autoFocus` remains the explicit override. Otherwise fields are preferred
    // over footer buttons so every dialog opens ready for its primary task.
    const initial = dialog.querySelector<HTMLElement>("[autofocus]")
      || dialog.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])')
      || focusable()[0]
      || dialog;
    window.requestAnimationFrame(() => initial.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissOnEscape) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown);
      window.requestAnimationFrame(() => {
        const restoreTarget = restoreFocusRef.current;
        if (!hasActiveOverlay() && restoreTarget?.isConnected) restoreTarget.focus();
      });
    };
  }, [dismissOnEscape, ownsFocus]);

  useEffect(() => {
    if (dialogRef.current) dialogRef.current.inert = !ownsFocus;
  }, [ownsFocus]);

  if (typeof document === "undefined") return null;

  // Prefer .app-shell so --panel / --border / theme tokens resolve correctly.
  const host =
    document.querySelector(".app-shell") ||
    document.getElementById("root") ||
    document.body;

  return createPortal(
    <div
      className={clsx("modal-backdrop", palette && "modal-backdrop-palette")}
      data-overlay-owner={ownsFocus ? "true" : "false"}
      aria-hidden={!ownsFocus || undefined}
      style={{ zIndex: getOverlayLayer(overlayId), pointerEvents: ownsFocus ? "auto" : "none" }}
      onMouseDown={(event) => {
        if (!ownsFocus || !dismissOnBackdrop || event.target !== event.currentTarget) return;
        onCloseRef.current();
      }}
      onWheel={(event) => event.stopPropagation()}
    >
      <div
        ref={dialogRef}
        className={clsx(
          "modal",
          compact && "modal-compact",
          palette && "modal-palette",
          palette && compact && "modal-palette-compact",
        )}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
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
