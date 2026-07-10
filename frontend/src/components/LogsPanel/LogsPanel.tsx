import { useEffect, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ListLogFiles } from "../../../wailsjs/go/main/App";
import { t } from "../../i18n";

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

export function LogsPanel(props: { locale: string; onOpenLog: (name: string) => void }) {
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
