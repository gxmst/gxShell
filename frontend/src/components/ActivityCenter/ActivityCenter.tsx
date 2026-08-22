import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Bell, Check, CheckCheck, CircleAlert, Info, ShieldAlert, Trash2, X } from "lucide-react";
import type { ActivityAction, ActivityCategory, ActivityRecord } from "../../types";
import { t, type LangKey } from "../../i18n";

type ActivityFilter = "all" | "unread" | "errors";

export type ActivityCenterProps = {
  activities: ActivityRecord[];
  unreadCount?: number;
  locale?: string;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onMarkRead?: (id: string) => void;
  onMarkAllRead?: () => void;
  onDismiss?: (id: string) => void;
  onClear?: () => void;
  onAction?: (activity: ActivityRecord, action: ActivityAction) => void | Promise<void>;
  /** Replace the default bell trigger with an app-specific button. */
  trigger?: ReactNode;
  /** Render only the panel when the surrounding app owns its trigger. */
  showTrigger?: boolean;
  className?: string;
};

function severityIcon(activity: ActivityRecord) {
  if (activity.severity === "error") return <CircleAlert size={14} />;
  if (activity.severity === "warning") return <ShieldAlert size={14} />;
  if (activity.severity === "success") return <Check size={14} />;
  return <Info size={14} />;
}

function categoryKey(category: ActivityCategory): LangKey {
  const map: Record<ActivityCategory, LangKey> = {
    connection: "notificationConnection",
    transfer: "notificationTransfer",
    automation: "notificationAutomation",
    security: "notificationSecurity",
    terminal: "notificationTerminal",
    update: "notificationUpdate",
    system: "notificationSystem",
    other: "notificationOther",
  };
  return map[category];
}

function formatTimestamp(timestamp: number, locale: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const language = locale === "zh-CN" ? "zh-CN" : "en";
  return new Intl.DateTimeFormat(language, sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function ActivityCenter({
  activities,
  unreadCount,
  locale = "en",
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
  onClear,
  onAction,
  trigger,
  showTrigger = true,
  className = "",
}: ActivityCenterProps) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : internalOpen;
  const unread = unreadCount ?? activities.filter((item) => item.unread).length;

  const setOpen = useCallback((next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }, [isControlled, onOpenChange]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, setOpen]);

  const visible = useMemo(() => activities.filter((item) => {
    if (filter === "unread") return item.unread;
    if (filter === "errors") return item.severity === "error" || item.severity === "warning";
    return true;
  }), [activities, filter]);

  const runAction = (activity: ActivityRecord, action: ActivityAction) => {
    try {
      const result = onAction ? onAction(activity, action) : action.onClick?.();
      if (result && typeof (result as Promise<void>).catch === "function") void (result as Promise<void>).catch(() => undefined);
    } catch {
      // An action belongs to its producer. The center must stay usable even if
      // a producer has already been disposed when the user clicks it.
    }
  };

  return (
    <div className={`activity-center ${className}`.trim()}>
      {showTrigger && (trigger || (
        <button
          type="button"
          className="activity-center-trigger"
          aria-label={t(locale, "notificationCenter")}
          title={t(locale, "notificationCenter")}
          aria-expanded={isOpen}
          onClick={() => setOpen(!isOpen)}
        >
          <Bell size={15} />
          {unread > 0 && <span className="activity-center-badge" aria-label={`${unread}`}>{unread > 99 ? "99+" : unread}</span>}
        </button>
      ))}

      {isOpen && (
        <section className="activity-center-panel" role="dialog" aria-label={t(locale, "notificationCenter")}>
          <header className="activity-center-header">
            <div className="activity-center-heading">
              <span className="activity-center-icon"><Bell size={14} /></span>
              <div>
                <strong>{t(locale, "notifications")}</strong>
                {unread > 0 && <small>{unread} {t(locale, "notificationUnread").toLocaleLowerCase(locale)}</small>}
              </div>
            </div>
            <div className="activity-center-actions">
              {unread > 0 && onMarkAllRead && <button type="button" className="activity-center-icon-button" title={t(locale, "notificationMarkAllRead")} aria-label={t(locale, "notificationMarkAllRead")} onClick={onMarkAllRead}><CheckCheck size={13} /></button>}
              {activities.length > 0 && onClear && <button type="button" className="activity-center-icon-button" title={t(locale, "notificationClearAll")} aria-label={t(locale, "notificationClearAll")} onClick={onClear}><Trash2 size={13} /></button>}
              <button type="button" className="activity-center-icon-button" title={t(locale, "close")} aria-label={t(locale, "close")} onClick={() => setOpen(false)}><X size={13} /></button>
            </div>
          </header>

          <div className="activity-center-filters" role="tablist" aria-label={t(locale, "notificationCenter")}>
            {(["all", "unread", "errors"] as ActivityFilter[]).map((item) => {
              const label = item === "all" ? t(locale, "notificationAll") : item === "unread" ? t(locale, "notificationUnread") : t(locale, "notificationErrors");
              return <button key={item} type="button" role="tab" aria-selected={filter === item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{label}</button>;
            })}
          </div>

          <div className="activity-center-list" role="list">
            {visible.length === 0 && <div className="activity-center-empty"><Bell size={18} /><span>{t(locale, "notificationNoItems")}</span></div>}
            {visible.map((activity) => (
              <article
                key={activity.id}
                role="listitem"
                className={`activity-item activity-item-${activity.severity} ${activity.unread ? "unread" : ""}`}
                onClick={() => activity.unread && onMarkRead?.(activity.id)}
              >
                <span className="activity-item-signal" aria-hidden="true">{severityIcon(activity)}</span>
                <div className="activity-item-body">
                  <div className="activity-item-topline">
                    <div className="activity-item-title">{activity.title || t(locale, categoryKey(activity.category))}</div>
                    <time dateTime={new Date(activity.timestamp).toISOString()}>{formatTimestamp(activity.timestamp, locale)}</time>
                  </div>
                  <div className="activity-item-text">{activity.text}</div>
                  {(activity.scopeLabel || activity.occurrences && activity.occurrences > 1) && (
                    <div className="activity-item-meta">
                      {activity.scopeLabel && <span>{activity.scopeLabel}</span>}
                      {activity.occurrences && activity.occurrences > 1 && <span>{t(locale, "notificationOccurrences", { count: String(activity.occurrences) })}</span>}
                    </div>
                  )}
                  {activity.detail && <div className="activity-item-detail">{activity.detail}</div>}
                  {activity.actions && activity.actions.length > 0 && (
                    <div className="activity-item-actions" onClick={(event) => event.stopPropagation()}>
                      {activity.actions.map((action) => <button key={action.id} type="button" className={`activity-action activity-action-${action.variant || "secondary"}`} disabled={action.disabled || (!onAction && !action.onClick)} onClick={() => runAction(activity, action)}>{action.label}</button>)}
                    </div>
                  )}
                </div>
                <div className="activity-item-row-actions" onClick={(event) => event.stopPropagation()}>
                  {activity.unread && onMarkRead && <button type="button" className="activity-center-icon-button" title={t(locale, "notificationMarkRead")} aria-label={t(locale, "notificationMarkRead")} onClick={() => onMarkRead(activity.id)}><Check size={12} /></button>}
                  {onDismiss && <button type="button" className="activity-center-icon-button" title={t(locale, "notificationDismiss")} aria-label={t(locale, "notificationDismiss")} onClick={() => onDismiss(activity.id)}><X size={12} /></button>}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Backwards/semantic alias for callers that prefer the product wording. */
export const NotificationCenter = ActivityCenter;

export default ActivityCenter;
