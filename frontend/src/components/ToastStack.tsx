import clsx from "clsx";
import type { Toast } from "../types";

export function ToastStack({ toasts }: { toasts: Toast[] }) {
  return <div className="toast-stack" aria-live="polite" aria-relevant="additions">{toasts.map((toast) => <div key={toast.id} role={toast.tone === "error" ? "alert" : "status"} aria-atomic="true" className={clsx("toast", `toast-${toast.tone}`)}>{toast.text}</div>)}</div>;
}
