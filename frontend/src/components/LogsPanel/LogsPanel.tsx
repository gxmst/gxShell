import { useEffect, useState, useCallback, useId, useRef } from "react";
import { Activity, AlertCircle, CheckCircle2, FileText, Loader2, RefreshCw } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ListLogFiles, ListSessionLogFiles } from "../../../wailsjs/go/app/App";
import { t } from "../../i18n";
import type { AutomationActivityRecord } from "../../types";
import { handleTabKeyDown } from "../../utils/tabNavigation";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(d: string): string {
  if (!d) return "";
  const date = new Date(d);
  return date.toLocaleString();
}

export function LogsPanel(props: { locale: string; onOpenLog: (name: string, sessionLog?: boolean) => void; activities: AutomationActivityRecord[] }) {
  const [files, setFiles] = useState<types.LogFile[]>([]);
  const [sessionLog, setSessionLog] = useState(false);
  const tabsId = useId();
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef(0);

  const loadFiles = useCallback(async () => {
    const revision = ++request.current;
    setLoading(true);
    setError("");
    try {
      const list = await (sessionLog ? ListSessionLogFiles() : ListLogFiles());
      if (revision === request.current) setFiles(list || []);
    } catch (err) {
      if (revision === request.current) { setFiles([]); setError(String(err)); }
    } finally {
      if (revision === request.current) setLoading(false);
    }
  }, [sessionLog]);

  useEffect(() => {
    const pendingRequest = request;
    setFiles([]);
    void loadFiles();
    return () => { pendingRequest.current++; };
  }, [loadFiles]);

  return (
    <div className="logs-file-only panel-page">
      <div className="logs-toolbar panel-page-header">
        <div className="panel-page-heading"><span className="panel-page-icon"><FileText size={14} /></span><span><strong>{t(props.locale, "logFiles")}</strong><small>{t(props.locale, "logsSubtitle")}</small></span></div>
        <button className="panel-page-action" disabled={loading} onClick={loadFiles} title={t(props.locale, "refresh")}><RefreshCw size={12} /></button>
      </div>
      <div className="segment-control" role="tablist" aria-label={t(props.locale, "logFiles")} onKeyDown={handleTabKeyDown}>
        <button type="button" className={`segment-btn${!sessionLog ? " segment-btn-active" : ""}`} role="tab" id={`${tabsId}-application`} aria-controls={`${tabsId}-panel`} aria-selected={!sessionLog} tabIndex={!sessionLog ? 0 : -1} onClick={() => setSessionLog(false)}><span>{t(props.locale, "logsApplication")}</span></button>
        <button type="button" className={`segment-btn${sessionLog ? " segment-btn-active" : ""}`} role="tab" id={`${tabsId}-sessions`} aria-controls={`${tabsId}-panel`} aria-selected={sessionLog} tabIndex={sessionLog ? 0 : -1} onClick={() => setSessionLog(true)}><span>{t(props.locale, "logsSessions")}</span></button>
      </div>
      <div className="logs-tab-panel" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${sessionLog ? "sessions" : "application"}`} tabIndex={0}>
        <div><input className="input compact-input" aria-label={t(props.locale, "filterLogs")} placeholder={t(props.locale, "filterLogs")} value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        {error && <div className="text-bad" role="alert">{error}</div>}
        {loading && <div>{t(props.locale, "loading")}</div>}
        {!sessionLog && !!props.activities.length && (
          <section>
            <div className="flex items-center gap-1.5 pb-1.5 text-[10px] font-semibold text-muted"><Activity size={11} />{t(props.locale, "recentActivity")}</div>
            <div className="panel-list max-h-48 overflow-auto rounded border border-border/50">
              {props.activities.slice(0, 20).map((item, index) => {
                const icon = item.phase === "started" ? <Loader2 size={11} className="animate-spin" /> : item.phase === "failed" ? <AlertCircle size={11} className="text-bad" /> : <CheckCircle2 size={11} className="text-ok" />;
                const summary = item.command || item.tool || (item.source === "ai" ? "AI" : "CLI");
                return (
                  <div key={`${item.activityId}-${item.phase}-${item.timestamp}-${index}`} className="panel-item">
                    <span className="panel-item-icon">{icon}</span>
                    <div className="panel-item-copy">
                      <div className="panel-item-title">{item.source.toUpperCase()} · {item.title || item.sessionId}</div>
                      <div className="panel-item-meta" title={summary}>{summary}{item.durationMs ? ` · ${item.durationMs}ms` : ""}{item.error ? ` · ${item.error}` : ""}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
        <div className="logs-file-list panel-list">
          {files.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())).map((f) => (
            <button key={f.name} className="logs-file-item panel-item" disabled={loading} onClick={() => props.onOpenLog(f.name, sessionLog)}>
              <span className="panel-item-icon"><FileText size={12} /></span>
              <div className="panel-item-copy">
                <div className="panel-item-title">{f.name}</div>
                <div className="panel-item-meta">{formatSize(f.size)} · {formatTime(f.modTime as unknown as string)}</div>
              </div>
            </button>
          ))}
          {!loading && !files.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())).length && <div className="panel-empty"><FileText size={20} /><span>{t(props.locale, "noLogFiles")}</span></div>}
        </div>
      </div>
    </div>
  );
}
