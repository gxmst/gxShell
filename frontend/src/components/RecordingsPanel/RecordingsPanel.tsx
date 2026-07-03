import { useCallback, useEffect, useState } from "react";
import { Clock, FolderOpen, Play, RefreshCw, Trash2, Video } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ListRecordings, DeleteRecording, OpenRecordingsDir } from "../../../wailsjs/go/main/App";
import type { Tab } from "../../types";
import { t } from "../../i18n";
import { CastPlayer } from "../CastPlayer/CastPlayer";

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
  active?: Tab;
  locale: string;
  settings: types.AppSettings | null;
  onNotify?: (text: string, tone?: "info" | "error" | "success") => void;
}) {
  const lang = props.locale;
  const [recordings, setRecordings] = useState<types.Recording[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);

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
    <div className="recordings-panel">
      <div className="recordings-toolbar">
        <span className="recordings-toolbar-title">{t(lang, "recordings")}</span>
        <div className="flex items-center gap-1">
          <button className="mini-btn" onClick={() => OpenRecordingsDir().catch(() => {})} title={t(lang, "openRecordingsDir")}><FolderOpen size={11} /></button>
          <button className="mini-btn" onClick={load} title={t(lang, "refresh")}><RefreshCw size={11} /></button>
        </div>
      </div>
      <div className="recordings-hint">{t(lang, "recordingsHint")}</div>
      <div className="recordings-list">
        {recordings.map((rec) => (
          <div key={rec.name} className="recording-row">
            <Video size={13} className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1" onClick={() => setPlaying(rec.name)} role="button">
              <div className="truncate text-[11px] font-medium">{rec.name}</div>
              <div className="flex items-center gap-1 text-[9px] text-muted">
                <Clock size={8} /> {formatTime(rec.modTime)} · {formatSize(rec.size)}
              </div>
            </div>
            <button className="mini-btn" onClick={() => setPlaying(rec.name)} title={t(lang, "playRecording")}><Play size={11} /></button>
            <button className="mini-btn danger" onClick={() => remove(rec.name)} title={t(lang, "deleteRecording")}><Trash2 size={11} /></button>
          </div>
        ))}
        {!recordings.length && <div className="empty">{t(lang, "noRecordings")}</div>}
      </div>
      {playing && (
        <CastPlayer name={playing} settings={props.settings} locale={lang} onClose={() => setPlaying(null)} />
      )}
    </div>
  );
}
