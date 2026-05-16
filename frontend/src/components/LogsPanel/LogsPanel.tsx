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
    <div className="logs-file-only">
      <div className="logs-toolbar">
        <span className="logs-toolbar-title">{t(props.locale, "logFiles")}</span>
        <button className="mini-btn" onClick={loadFiles} title={t(props.locale, "refresh")}><RefreshCw size={11} /></button>
      </div>
      <div className="logs-file-list">
        {files.map((f) => (
          <div key={f.name} className="logs-file-item" onClick={() => props.onOpenLog(f.name)}>
            <FileText size={12} className="shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-medium">{f.name}</div>
              <div className="text-[9px] text-muted">{formatSize(f.size)} · {formatTime(f.modTime as unknown as string)}</div>
            </div>
          </div>
        ))}
        {!files.length && <div className="empty">{t(props.locale, "noLogFiles")}</div>}
      </div>
    </div>
  );
}
