import { useCallback, useEffect, useState } from "react";
import { Clock, FolderOpen, Play, RefreshCw, Trash2, Video } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ListRecordings, DeleteRecording, OpenRecordingsDir } from "../../../wailsjs/go/app/App";
import { t } from "../../i18n";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(d: unknown): string {
  const raw = d as string;
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

export function RecordingsPanel(props: {
  locale: string;
  onPlay: (name: string) => void;
  onNotify?: (text: string, tone?: "info" | "error" | "success") => void;
}) {
  const lang = props.locale;
  const [recordings, setRecordings] = useState<types.Recording[]>([]);

  const load = useCallback(async () => {
    try {
      const list = await ListRecordings();
      setRecordings(list || []);
    } catch {
      setRecordings([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (name: string) => {
    try {
      await DeleteRecording(name);
      setRecordings((prev) => prev.filter((r) => r.name !== name));
    } catch (err) {
      props.onNotify?.(String(err), "error");
    }
  };

  return (
    <div className="recordings-panel panel-page">
      <div className="recordings-toolbar panel-page-header">
        <div className="panel-page-heading"><span className="panel-page-icon"><Video size={14} /></span><span><strong>{t(lang, "recordings")}</strong><small>{t(lang, "recordingsSubtitle")}</small></span></div>
        <div className="panel-page-actions">
          <button className="panel-page-action" onClick={() => OpenRecordingsDir().catch(() => {})} title={t(lang, "openRecordingsDir")}><FolderOpen size={11} /></button>
          <button className="panel-page-action" onClick={load} title={t(lang, "refresh")}><RefreshCw size={11} /></button>
        </div>
      </div>
      <div className="recordings-hint">{t(lang, "recordingsHint")}</div>
      <div className="recordings-list panel-list">
        {recordings.map((rec) => (
          <div key={rec.name} className="recording-row panel-item">
            <span className="panel-item-icon"><Video size={13} /></span>
            <button type="button" className="panel-item-copy text-left" onClick={() => props.onPlay(rec.name)}>
              <div className="panel-item-title">{rec.name}</div>
              <div className="panel-item-meta flex items-center gap-1">
                <Clock size={8} /> {formatTime(rec.modTime)} · {formatSize(rec.size)}
              </div>
            </button>
            <div className="panel-item-actions"><button className="mini-btn" onClick={() => props.onPlay(rec.name)} title={t(lang, "playRecording")}><Play size={11} /></button>
            <button className="mini-btn danger" onClick={() => remove(rec.name)} title={t(lang, "deleteRecording")}><Trash2 size={11} /></button></div>
          </div>
        ))}
        {!recordings.length && <div className="panel-empty"><Video size={20} /><span>{t(lang, "noRecordings")}</span></div>}
      </div>
    </div>
  );
}
