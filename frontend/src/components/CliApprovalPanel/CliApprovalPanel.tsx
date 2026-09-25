import clsx from "clsx";
import { AlertTriangle, ChevronDown, ChevronRight, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import type { LangKey } from "../../i18n";
import type { CliApprovalPanelItem, CliApprovalPanelRequest } from "../../types";
import { splitRiskText } from "../CliApprovalQueue/riskText";

// The panel is the review surface for an external CLI or AI request. It exists
// because the native MessageBox could not carry a review: it has no scrollbar,
// so a long batch pushed its own buttons off the screen, and on Windows it
// ignored the caller's button labels. Everything the native dialog showed is
// still here, plus grouping, scrolling and per-item selection.
//
// The list is never truncated. The one bucket that is collapsed by default is
// T0, which cannot change anything; collapsing is a convenience there, never a
// way to hide a mutation.

type GroupKey = "critical" | "changes" | "recoverable" | "unclassified" | "readonly";

// One group per tier, in descending severity, so the header alone tells the
// user what kind of thing they are looking at. The tier code is shown verbatim
// because it is the same label the risk lines and the audit log use.
const GROUPS: { key: GroupKey; tier: string; label: LangKey }[] = [
  { key: "critical", tier: "T3", label: "approvalPanelCritical" },
  { key: "changes", tier: "T2", label: "approvalPanelChanges" },
  { key: "recoverable", tier: "T1", label: "approvalPanelRecoverable" },
  { key: "unclassified", tier: "", label: "approvalPanelUnclassified" },
  { key: "readonly", tier: "T0", label: "approvalPanelReadonly" },
];

// Only T0 starts collapsed. T1 is a *recoverable change*, not an observation,
// so it stays visible: a change the user did not read is the failure this panel
// exists to prevent. Anything the classifier could not tier stays visible for
// the same reason — undecidable never means "probably fine".
const DEFAULT_COLLAPSED: Record<GroupKey, boolean> = {
  critical: false,
  changes: false,
  recoverable: false,
  unclassified: false,
  readonly: true,
};

function groupOf(item: CliApprovalPanelItem): GroupKey {
  const tier = (item.riskTier || "").trim().toUpperCase();
  if (tier === "T3") return "critical";
  if (tier === "T2") return "changes";
  if (tier === "T1") return "recoverable";
  if (tier === "T0") return "readonly";
  return "unclassified";
}

function RiskText({ item }: { item: CliApprovalPanelItem }) {
  const parts = splitRiskText(item.text || "", item.spans || []);
  return (
    <>
      {parts.map((part, index) => part.className
        ? <mark key={`${index}-${part.text}`} className={part.className} title={part.note}>{part.text}</mark>
        : <span key={`${index}-${part.text}`}>{part.text}</span>)}
    </>
  );
}

export function CliApprovalPanel({ request, locale, onResolve }: {
  request: CliApprovalPanelRequest;
  locale: string;
  onResolve: (approvedIds: string[]) => void;
}) {
  const items = useMemo(() => request.items || [], [request.items]);

  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(items.map((item) => item.id)),
  );
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({ ...DEFAULT_COLLAPSED });

  // The key handler is registered once and reads the live selection through a
  // ref, so pressing Enter always resolves against what is on screen now.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const resolvedRef = useRef(false);

  const resolve = useCallback((ids: string[]) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    onResolve(ids);
  }, [onResolve]);

  useEffect(() => {
    // Focus the panel so a keyboard user lands inside the review surface rather
    // than back in the terminal.
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;

      // Enter is the panel-wide "approve what is ticked" shortcut, but a
      // focused button owns Enter: pressing it on Deny must deny, on a group
      // header must fold that group, and on "Allow all" must allow everything.
      // Hijacking it here made all three do the wrong thing.
      const target = event.target;
      if (event.key === "Enter" && target instanceof Element && target.closest("button")) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        resolve([]);
        return;
      }
      if (event.key === "Enter") {
        // Enter approves the current selection, never the whole batch. If the
        // user unchecked something, one keystroke must not run it anyway.
        event.preventDefault();
        event.stopPropagation();
        resolve(Array.from(selectedRef.current));
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [resolve]);

  const groups = useMemo(() => {
    const buckets: Record<GroupKey, CliApprovalPanelItem[]> = {
      critical: [], changes: [], recoverable: [], unclassified: [], readonly: [],
    };
    for (const item of items) buckets[groupOf(item)].push(item);
    return GROUPS
      .map((group) => ({ ...group, items: buckets[group.key] }))
      .filter((group) => group.items.length > 0);
  }, [items]);

  const selectedCount = selected.size;

  const toggleItem = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleGroup = (key: GroupKey) => {
    setCollapsed((previous) => ({ ...previous, [key]: !previous[key] }));
  };

  const toggleAll = () => {
    setSelected((previous) => {
      const allSelected = previous.size === items.length;
      return allSelected ? new Set() : new Set(items.map((item) => item.id));
    });
  };

  return (
    <div className="cli-panel-backdrop" role="presentation">
      <div
        className="cli-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t(locale, "approvalPanelTitle")}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="cli-panel-head">
          <span className="cli-panel-icon"><ShieldAlert size={17} /></span>
          <div className="cli-panel-heading">
            <strong>{t(locale, "approvalPanelTitle")}</strong>
            <small>
              {request.source === "ai" ? t(locale, "approvalPanelSourceAi") : t(locale, "approvalPanelSourceCli")}
              {request.server ? ` · ${request.server}` : ""}
            </small>
          </div>
          <span className="cli-panel-count">{t(locale, "approvalPanelSelected", { count: String(selectedCount), total: String(items.length) })}</span>
        </header>

        {request.summary && <p className="cli-panel-summary">{request.summary}</p>}
        {request.critical && (
          <p className="cli-panel-critical-hint">
            <AlertTriangle size={12} />
            <span>{t(locale, "approvalPanelCriticalHint")}</span>
          </p>
        )}

        <div className="cli-panel-tools">
          <label className="cli-panel-selectall">
            <input type="checkbox" checked={selectedCount === items.length && items.length > 0} onChange={toggleAll} />
            <span>{t(locale, "approvalPanelSelectAll")}</span>
          </label>
        </div>

        <div className="cli-panel-list">
          {groups.map((group) => {
            const isCollapsed = collapsed[group.key];
            const groupSelected = group.items.filter((item) => selected.has(item.id)).length;
            return (
              <section
                key={group.key}
                // Written out rather than built from group.key so the class
                // names stay greppable and check-css can see them.
                className={clsx(
                  "cli-panel-group",
                  group.key === "critical" && "cli-panel-group-critical",
                  group.key === "changes" && "cli-panel-group-changes",
                  group.key === "recoverable" && "cli-panel-group-recoverable",
                  group.key === "unclassified" && "cli-panel-group-unclassified",
                  group.key === "readonly" && "cli-panel-group-readonly",
                )}
              >
                <button
                  type="button"
                  className="cli-panel-group-head"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                  {group.tier && <span className="cli-panel-group-tier">{group.tier}</span>}
                  <span className="cli-panel-group-title">{t(locale, group.label)}</span>
                  <span className="cli-panel-group-meta">
                    {t(locale, "approvalPanelGroupCount", {
                      selected: String(groupSelected),
                      total: String(group.items.length),
                    })}
                  </span>
                </button>
                {!isCollapsed && group.items.map((item) => (
                  <article key={item.id} className={`cli-panel-item${selected.has(item.id) ? "" : " is-off"}`}>
                    <label className="cli-panel-item-check">
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggleItem(item.id)}
                        aria-label={item.text}
                      />
                    </label>
                    <div className="cli-panel-item-body">
                      {(item.riskTier || item.riskLabel) && (
                        <p className="cli-panel-item-risk">
                          {item.riskTier && <span className="cli-panel-item-tier">{item.riskTier}</span>}
                          {item.riskLabel && <span>{item.riskLabel}</span>}
                        </p>
                      )}
                      <pre className="cli-panel-item-text"><RiskText item={item} /></pre>
                      {!!item.riskLines?.length && (
                        <div className="cli-panel-item-lines">
                          {/* Every line, not the first few: the list scrolls, and
                              the native dialog's own explanation counted the ones
                              it dropped ("and N more"). Losing them here would
                              hide exactly what the panel exists to show. */}
                          {item.riskLines.map((line) => (
                            <div key={line}><AlertTriangle size={11} /><span>{line}</span></div>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </section>
            );
          })}
        </div>

        <footer className="cli-panel-actions">
          <button type="button" className="cli-panel-btn" onClick={() => resolve([])}>
            {t(locale, "approvalPanelDeny")}
          </button>
          <span className="cli-panel-actions-gap" />
          <button
            type="button"
            className="cli-panel-btn cli-panel-btn-primary"
            disabled={selectedCount === 0}
            onClick={() => resolve(Array.from(selected))}
          >
            {t(locale, "approvalPanelAllowSelected", { count: String(selectedCount) })}
          </button>
          <button
            type="button"
            className="cli-panel-btn cli-panel-btn-danger"
            disabled={items.length === 0}
            onClick={() => resolve(items.map((item) => item.id))}
          >
            {t(locale, "approvalPanelAllowAll", { count: String(items.length) })}
          </button>
        </footer>
      </div>
    </div>
  );
}
