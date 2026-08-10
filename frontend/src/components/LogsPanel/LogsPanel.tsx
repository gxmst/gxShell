import { useEffect, useState } from "react";
import { Activity, AlertCircle, CheckCircle2, FileText, Loader2, RefreshCw } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ListLogFiles } from "../../../wailsjs/go/app/App";
import { t } from "../../i18n";
import type { AutomationActivityRecord } from "../../types";

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

export function LogsPanel(props: { locale: string; onOpenLog: (name: string) => void; activities: AutomationActivityRecord[] }) {
  const [files, setFiles] = useState<types.LogFile[]>([]);

  const loadFiles = async () => {
    try {
      const list = await ListLogFiles();
      setFiles(list || []);
    } catch {
      setFiles([]);
    }
  };

  useEffect(() => {
    loadFiles();
  }, []);

  return (
    <div className="logs-file-only panel-page">
      <div className="logs-toolbar panel-page-header">
        <div className="panel-page-heading"><span className="panel-page-icon"><FileText size={14} /></span><span><strong>{t(props.locale, "logFiles")}</strong><small>{props.locale === "zh-CN" ? "应用运行记录与诊断" : "Application activity and diagnostics"}</small></span></div>
        <button className="panel-page-action" onClick={loadFiles} title={t(props.locale, "refresh")}><RefreshCw size={12} /></button>
      </div>
      {!!props.activities.length && (
        <section className="px-3 pb-2">
          <div className="flex items-center gap-1.5 pb-1.5 text-[10px] font-semibold text-muted"><Activity size={11} />{props.locale === "zh-CN" ? "最近活动" : "Recent activity"}</div>
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
        {files.map((f) => (
          <div key={f.name} className="logs-file-item panel-item" onClick={() => props.onOpenLog(f.name)}>
            <span className="panel-item-icon"><FileText size={12} /></span>
            <div className="panel-item-copy">
              <div className="panel-item-title">{f.name}</div>
              <div className="panel-item-meta">{formatSize(f.size)} · {formatTime(f.modTime as unknown as string)}</div>
            </div>
          </div>
        ))}
        {!files.length && <div className="panel-empty"><FileText size={20} /><span>{t(props.locale, "noLogFiles")}</span></div>}
      </div>
    </div>
  );
}
