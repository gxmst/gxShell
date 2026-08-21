import clsx from "clsx";
import { lazy, memo, Suspense, useCallback, useMemo, useRef, type ReactNode } from "react";
import { Plus, Radio, TerminalSquare, X } from "lucide-react";
import type { AutomationIndicator, MarkdownOpenTarget, SplitPane, Tab } from "../../types";
import { TabBar } from "../TabBar/TabBar";
import { TerminalStatusBar } from "./TerminalStatusBar";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";

// Lazy-loaded: MarkdownViewer pulls in marked, DOMPurify, highlight.js and
// mermaid, which together dominate the bundle. Splitting them out keeps them
// off the startup path so the app only fetches them when a text file is opened.
const MarkdownViewer = lazy(() => import("../MarkdownViewer/MarkdownViewer"));

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
  onNewLocal?: () => void;
  onOpenMarkdown?: () => void;
  onOpenMarkdownFile?: (target: MarkdownOpenTarget) => void;
  onTearOff?: (tab: Tab) => void;
  onReorder?: (draggedId: string, targetId: string) => void;
  onRenameTab?: (tab: Tab) => void;
  onTogglePinTab?: (tab: Tab) => void;
  rightAccessory?: ReactNode;
  language: string;
  logViewer?: { name: string; content: string } | null;
  onCloseLogViewer?: () => void;
  floatingTabIds?: string[];
  splitPane?: SplitPane | null;
  onSplitChange?: (split: SplitPane | null) => void;
  refitTerminal?: (id: string) => void;
  onNotify?: (text: string, tone?: "info" | "error" | "success") => void;
  broadcastInput?: boolean;
  broadcastCount?: number;
  onToggleBroadcast?: () => void;
  activeRecording?: boolean;
  onToggleRecording?: (id: string) => void;
  automationActivity?: Record<string, AutomationIndicator>;
  dirtyTabIds?: string[];
  onMarkdownDirtyChange?: (id: string, dirty: boolean, save: () => Promise<boolean>) => void;
  getDimensions?: (id: string) => { cols: number; rows: number } | null;
  getCurrentDirectory?: (id: string) => { path: string; host?: string } | null;
  onOpenCurrentDirectory?: (id: string, path: string) => void;
}) {
  const lang = props.language;
  const floatingSet = useMemo(() => new Set(props.floatingTabIds || []), [props.floatingTabIds]);
  const visibleTabs = useMemo(() => props.tabs.filter((tab) => !floatingSet.has(tab.id)), [props.tabs, floatingSet]);
  const active = props.tabs.find((tab) => tab.id === props.activeTab);
  const split = props.splitPane;
  const splitRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const splitDragRef = useRef<{ pointerId: number; split: SplitPane; bounds: DOMRect; ratio: number; frame: number } | null>(null);

  const applyLiveSplit = useCallback((splitValue: SplitPane, ratio: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    if (splitValue.direction === "horizontal") {
      stage.style.gridTemplateColumns = `${ratio}fr 4px ${1 - ratio}fr`;
    } else {
      stage.style.gridTemplateRows = `${ratio}fr 4px ${1 - ratio}fr`;
    }
  }, []);

  const onDragSplit = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!split || !splitRef.current?.parentElement) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    splitDragRef.current = {
      pointerId: e.pointerId,
      split,
      bounds: splitRef.current.parentElement.getBoundingClientRect(),
      ratio: split.ratio,
      frame: 0,
    };
  }, [split]);

  const onDragSplitMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = splitDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const pos = drag.split.direction === "horizontal" ? e.clientX - drag.bounds.left : e.clientY - drag.bounds.top;
    const total = drag.split.direction === "horizontal" ? drag.bounds.width : drag.bounds.height;
    drag.ratio = Math.min(0.8, Math.max(0.2, pos / total));
    if (drag.frame) return;
    drag.frame = requestAnimationFrame(() => {
      const current = splitDragRef.current;
      if (!current) return;
      current.frame = 0;
      applyLiveSplit(current.split, current.ratio);
    });
  }, [applyLiveSplit]);

  const finishSplitDrag = useCallback((e: React.PointerEvent<HTMLDivElement>, cancelled = false) => {
    const drag = splitDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.frame) cancelAnimationFrame(drag.frame);
    splitDragRef.current = null;
    const ratio = cancelled ? drag.split.ratio : drag.ratio;
    applyLiveSplit(drag.split, ratio);
    if (!cancelled && ratio !== drag.split.ratio) props.onSplitChange?.({ ...drag.split, ratio });
    requestAnimationFrame(() => {
      props.refitTerminal?.(drag.split.left);
      props.refitTerminal?.(drag.split.right);
    });
  }, [applyLiveSplit, props.onSplitChange, props.refitTerminal]);

  const isSplitVisible = split && props.tabs.some((t) => t.id === split.left) && props.tabs.some((t) => t.id === split.right);

  const stageStyle: React.CSSProperties = isSplitVisible
    ? split.direction === "horizontal"
      ? { display: "grid", gridTemplateColumns: `${split.ratio}fr 4px ${1 - split.ratio}fr` }
      : { display: "grid", gridTemplateRows: `${split.ratio}fr 4px ${1 - split.ratio}fr` }
    : {};

  return (
    <section className="terminal-pane">
      <TabBar tabs={visibleTabs} activeTab={props.activeTab} profiles={props.profiles} sidebarCollapsed={props.sidebarCollapsed} onToggleSidebar={props.onToggleSidebar} onActive={props.onActive} onClose={props.onClose} onReconnect={props.onReconnect} onTearOff={props.onTearOff} onReorder={props.onReorder} onNewConnection={props.onNewConnection} onNewLocal={props.onNewLocal} onOpenMarkdown={props.onOpenMarkdown} onRename={props.onRenameTab} onTogglePin={props.onTogglePinTab} rightAccessory={props.rightAccessory} language={lang} broadcastInput={props.broadcastInput} broadcastAvailable={(props.broadcastCount || 0) > 1} onToggleBroadcast={props.onToggleBroadcast} recording={props.activeRecording} onToggleRecording={props.onToggleRecording} automationActivity={props.automationActivity} dirtyTabIds={props.dirtyTabIds} onSplitToggle={(tabId, direction) => {
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
      {active && active.type !== "markdown" && (active.state === "connecting" || active.state === "reconnecting" || active.state === "restoring") && (
        <div className="terminal-state-banner terminal-state-connecting">
          <span>{active.state === "reconnecting"
            ? (lang === "zh-CN" ? `正在重新连接 ${active.title}…` : `Reconnecting to ${active.title}…`)
            : active.state === "restoring"
              ? (lang === "zh-CN" ? `正在恢复 ${active.title}…` : `Restoring ${active.title}…`)
              : (lang === "zh-CN" ? `正在连接 ${active.title}…` : `Connecting to ${active.title}…`)}</span>
          <button onClick={() => props.onClose(active.id)}>{lang === "zh-CN" ? "取消" : "Cancel"}</button>
        </div>
      )}
      {active && active.type !== "markdown" && (active.state === "error" || active.state === "disconnected") && (
        <div className={clsx("terminal-state-banner", active.state === "error" && "terminal-state-error")}>
          <span title={active.error}>{active.error || (lang === "zh-CN" ? "连接已断开" : "Connection closed")}</span>
          {!active.local && <button onClick={() => props.onReconnect(active)}>{lang === "zh-CN" ? "重新连接" : "Reconnect"}</button>}
        </div>
      )}
      {props.broadcastInput && (props.broadcastCount || 0) > 1 && (
        <div className="broadcast-banner">
          <Radio size={13} className="shrink-0" />
          <span>{t(lang, "broadcastActive").replace("{n}", String(props.broadcastCount || 0))}</span>
          <button className="broadcast-banner-off" onClick={() => props.onToggleBroadcast?.()}>{t(lang, "broadcastStop")}</button>
        </div>
      )}
      <div className="terminal-stage" style={stageStyle} ref={stageRef}>
        {props.tabs.map((tab) => {
          const isFloating = floatingSet.has(tab.id);
          const isLeft = isSplitVisible && tab.id === split!.left;
          const isRight = isSplitVisible && tab.id === split!.right;
          const isSplitTab = isLeft || isRight;
          const isActive = props.activeTab === tab.id;

          let hostStyle: React.CSSProperties | undefined;
          let hostClass: string;

          if (isSplitVisible && isSplitTab) {
            hostClass = clsx("terminal-host", "terminal-split-pane", isActive && "terminal-split-active");
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
            >
              {tab.type === 'markdown' && (tab.filePath || tab.remotePath) && (
                <Suspense fallback={<div className="empty compact">{t(lang, "loading")}</div>}>
                  <MarkdownViewer
                    source={tab.markdownSource || (tab.remotePath ? 'remote' : 'local')}
                    filePath={tab.filePath}
                    remotePath={tab.remotePath}
                    sessionId={tab.remoteSessionId}
                    active={isActive && !isFloating}
                    visible={!!isSplitVisible && isSplitTab ? !isFloating : isActive && !isFloating}
                    locale={lang}
                    onClose={() => props.onClose(tab.id)}
                    onNotify={props.onNotify}
                    onOpenMarkdownFile={props.onOpenMarkdownFile}
                    onDirtyChange={(dirty, save) => props.onMarkdownDirtyChange?.(tab.id, dirty, save)}
                  />
                </Suspense>
              )}
            </div>
          );
        })}
        <div
          ref={splitRef}
          className={clsx("split-divider", !isSplitVisible && "split-divider-hidden", split?.direction === "vertical" && "split-divider-vertical")}
          style={isSplitVisible ? { gridColumn: split!.direction === "horizontal" ? "2" : "1", gridRow: split!.direction === "horizontal" ? "1" : "2" } : undefined}
          onPointerDown={onDragSplit}
          onPointerMove={onDragSplitMove}
          onPointerUp={(e) => finishSplitDrag(e)}
          onPointerCancel={(e) => finishSplitDrag(e, true)}
          onDoubleClick={() => {
            if (!split) return;
            props.onSplitChange?.({ ...split, ratio: 0.5 });
            requestAnimationFrame(() => {
              props.refitTerminal?.(split.left);
              props.refitTerminal?.(split.right);
            });
          }}
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
      {active && active.type !== "markdown" && (
        <TerminalStatusBar
          tabId={active.id}
          tab={active}
          profile={props.profiles.find((p) => p.id === active.profileId)}
          broadcastInput={props.broadcastInput}
          broadcastCount={props.broadcastCount}
          sessionCount={visibleTabs.filter((tab) => tab.type !== "markdown" && (tab.state === "connected" || tab.state === "connecting")).length}
          getDimensions={props.getDimensions}
          getCurrentDirectory={props.getCurrentDirectory}
          onOpenCurrentDirectory={props.onOpenCurrentDirectory}
          language={lang}
        />
      )}
    </section>
  );
});
