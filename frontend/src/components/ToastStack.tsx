import clsx from "clsx";
import type { Toast } from "../types";

export function ToastStack({ toasts }: { toasts: Toast[] }) {
  return <div className="toast-stack">{toasts.map((toast) => <div key={toast.id} className={clsx("toast", `toast-${toast.tone}`)}>{toast.text}</div>)}</div>;
}

