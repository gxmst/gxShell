import clsx from "clsx";
import { memo, useCallback, useRef } from "react";
import { Plus, TerminalSquare, X } from "lucide-react";
import type { SplitPane, Tab } from "../../types";
import { TabBar } from "../TabBar/TabBar";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";

export const TerminalArea = memo(function TerminalArea(props: {
  tabs: Tab[];
  activeTab: string;
  profiles: types.Profile[];
  terminalHosts: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onActive: (id: string) => void;
  onClose: (id: string) => void;
  onReconnect: (tab: Tab) => void;
  onNewConnection: () => void;
  onTearOff?: (tab: Tab) => void;
  language: string;
  logViewer?: { name: string; content: string } | null;
  onCloseLogViewer?: () => void;
  floatingTabIds?: string[];
  splitPane?: SplitPane | null;
  onSplitChange?: (split: SplitPane | null) => void;
  refitTerminal?: (id: string) => void;
}) {
  const lang = props.language;
  const floatingSet = new Set(props.floatingTabIds || []);
  const visibleTabs = props.tabs.filter((tab) => !floatingSet.has(tab.id));
  const split = props.splitPane;
  const splitRef = useRef<HTMLDivElement>(null);

  const onDragSplit = useCallback((e: React.MouseEvent) => {
    if (!split || !splitRef.current?.parentElement) return;
    e.preventDefault();
    const parent = splitRef.current.parentElement.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const pos = split.direction === "horizontal" ? ev.clientX - parent.left : ev.clientY - parent.top;
      const total = split.direction === "horizontal" ? parent.width : parent.height;
      const ratio = Math.min(0.8, Math.max(0.2, pos / total));
      props.onSplitChange?.({ ...split, ratio });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (split.left && split.right) {
        props.refitTerminal?.(split.left);
        props.refitTerminal?.(split.right);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [split, props.onSplitChange, props.refitTerminal]);

  const isSplitVisible = split && props.tabs.some((t) => t.id === split.left) && props.tabs.some((t) => t.id === split.right);

  const stageStyle: React.CSSProperties = isSplitVisible
    ? split.direction === "horizontal"
      ? { display: "grid", gridTemplateColumns: `${split.ratio * 100}% 4px ${(1 - split.ratio) * 100}%` }
      : { display: "grid", gridTemplateRows: `${split.ratio * 100}% 4px ${(1 - split.ratio) * 100}%` }
    : {};

  return (
    <section className="terminal-pane">
      <TabBar tabs={visibleTabs} activeTab={props.activeTab} profiles={props.profiles} sidebarCollapsed={props.sidebarCollapsed} onToggleSidebar={props.onToggleSidebar} onActive={props.onActive} onClose={props.onClose} onReconnect={props.onReconnect} onTearOff={props.onTearOff} onSplitToggle={(tabId, direction) => {
        if (!props.onSplitChange) return;
        if (isSplitVisible) {
          const leftId = split!.left;
          const rightId = split!.right;
          props.onSplitChange(null);
          setTimeout(() => {
            props.refitTerminal?.(leftId);
            props.refitTerminal?.(rightId);
          }, 80);
        } else {
          const other = visibleTabs.find((t) => t.id !== tabId && t.id !== props.activeTab);
          const rightId = other?.id || visibleTabs.find((t) => t.id !== tabId)?.id;
          if (rightId) {
            props.onSplitChange({ left: tabId, right: rightId, direction, ratio: 0.5 });
            setTimeout(() => {
              props.refitTerminal?.(tabId);
              props.refitTerminal?.(rightId);
            }, 120);
          }
        }
      }} />
      <div className="terminal-stage" style={stageStyle}>
        {props.tabs.map((tab) => {
          const isFloating = floatingSet.has(tab.id);
          const isLeft = isSplitVisible && tab.id === split!.left;
          const isRight = isSplitVisible && tab.id === split!.right;
          const isSplitTab = isLeft || isRight;
          const isActive = props.activeTab === tab.id;

          let hostStyle: React.CSSProperties | undefined;
          let hostClass: string;

          if (isSplitVisible && isSplitTab) {
            hostClass = clsx("terminal-host", "terminal-split-pane");
            if (isLeft) {
              hostStyle = split.direction === "horizontal"
                ? { gridColumn: "1", gridRow: "1" }
                : { gridColumn: "1", gridRow: "1" };
            } else {
              hostStyle = split.direction === "horizontal"
                ? { gridColumn: "3", gridRow: "1" }
                : { gridColumn: "1", gridRow: "3" };
            }
          } else if (isSplitVisible) {
            hostClass = clsx("terminal-host", "terminal-hidden");
          } else if (isActive && !isFloating) {
            hostClass = clsx("terminal-host");
          } else {
            hostClass = clsx("terminal-host", "terminal-hidden");
          }

          return (
            <div
              key={tab.id}
              data-tab-id={tab.id}
              className={hostClass}
              style={hostStyle}
              ref={(el) => { props.terminalHosts.current[tab.id] = el; }}
              onClick={isSplitTab ? () => props.onActive(tab.id) : undefined}
            />
          );
        })}
        <div
          ref={splitRef}
          className={clsx("split-divider", !isSplitVisible && "split-divider-hidden", split?.direction === "vertical" && "split-divider-vertical")}
          style={isSplitVisible ? { gridColumn: split!.direction === "horizontal" ? "2" : "1", gridRow: split!.direction === "horizontal" ? "1" : "2" } : undefined}
          onMouseDown={onDragSplit}
        />
        {props.logViewer && (
          <div className="log-viewer-overlay">
            <div className="log-viewer-header">
              <span className="log-viewer-title">{props.logViewer.name}</span>
              <button className="mini-btn" onClick={props.onCloseLogViewer}><X size={12} /></button>
            </div>
            <pre className="log-viewer-content">{props.logViewer.content}</pre>
          </div>
        )}
        {!visibleTabs.length && !props.logViewer && (
          <div className="terminal-empty">
            <div className="terminal-empty-card">
              <TerminalSquare className="mx-auto mb-3 h-11 w-11 text-muted" />
              <div className="text-lg font-semibold">{t(lang, "noActiveTerminal")}</div>
              <div className="mt-1 text-sm text-muted">{t(lang, "noActiveTerminalHint")}</div>
              <div className="mt-4 flex justify-center">
                <button className="btn-primary" onClick={props.onNewConnection}><Plus size={15} /> {t(lang, "newConnection")}</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
});
