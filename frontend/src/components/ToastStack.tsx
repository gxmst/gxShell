import clsx from "clsx";
import type { Toast } from "../types";
import { X } from "lucide-react";
import { t } from "../i18n";

export function ToastStack({ toasts, onDismiss, onAction, locale = "en" }: { toasts: Toast[]; onDismiss?: (id: string) => void; onAction?: (toast: Toast, actionId: string) => void; locale?: string }) {
  return <div className="toast-stack" aria-live="polite" aria-relevant="additions">{toasts.map((toast) => <div key={toast.id} role={toast.tone === "error" || toast.tone === "warning" ? "alert" : "status"} aria-atomic="true" className={clsx("toast", `toast-${toast.tone}`)}>
    <div className="toast-content">
      {toast.title && <div className="toast-title">{toast.title}</div>}
      <div className="toast-text">{toast.text}</div>
      {toast.actions && toast.actions.length > 0 && <div className="toast-actions">{toast.actions.map((action) => <button key={action.id} type="button" className={`toast-action toast-action-${action.variant || "secondary"}`} disabled={action.disabled || (!onAction && !action.onClick)} onClick={() => { if (onAction) onAction(toast, action.id); else action.onClick?.(); }}>{action.label}</button>)}</div>}
    </div>
    {onDismiss && <button type="button" className="toast-dismiss" aria-label={t(locale, "notificationDismiss")} onClick={() => onDismiss(toast.id)}><X size={12} /></button>}
  </div>)}</div>;
}
