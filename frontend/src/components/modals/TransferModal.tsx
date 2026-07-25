import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, File, Folder, RefreshCw, X } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ListLocalDir, LocalHomeDir, ListRemoteDir, UploadFile, DownloadFile } from "../../../wailsjs/go/main/App";
import { useTransfers } from "../../hooks/useTransfers";
import { formatFileSize } from "../../utils/format";
import { runQueue } from "../../utils/transferQueue";
import { t } from "../../i18n";
import { FloatingCard } from "../FloatingCard/FloatingCard";

export function TransferModal({ active, locale, initialLeft, initialTop, onClose }: { active?: { id: string }; locale: string; initialLeft?: number; initialTop?: number; onClose: () => void }) {
  const lang = locale;
  const activeSessionId = active?.id || "";
  const [localPath, setLocalPath] = useState("");
  const [localFiles, setLocalFiles] = useState<types.LocalFile[]>([]);
  const [localBusy, setLocalBusy] = useState(false);
  const [remoteView, setRemoteView] = useState<{ sessionId: string; path: string; files: types.RemoteFile[]; busy: boolean }>({ sessionId: "", path: "/", files: [], busy: false });
  const [selectedLocal, setSelectedLocal] = useState<Set<string>>(new Set());
  const [selectedRemote, setSelectedRemote] = useState<Set<string>>(new Set());
  const [lastLocalIdx, setLastLocalIdx] = useState(-1);
  const [lastRemoteIdx, setLastRemoteIdx] = useState(-1);
  const { transfers, history, cancelTransfer } = useTransfers();
  const remoteSeq = useRef(0);
  const remoteSessionRef = useRef(activeSessionId);
  if (remoteSessionRef.current !== activeSessionId) {
    remoteSessionRef.current = activeSessionId;
    remoteSeq.current += 1;
  }
  const remoteMatches = remoteView.sessionId === activeSessionId;
  const remotePath = remoteMatches ? remoteView.path : "/";
  const remoteFiles = remoteMatches ? remoteView.files : [];
  const remoteBusy = remoteMatches && remoteView.busy;

  useEffect(() => {
    LocalHomeDir().then((dir) => {
      setLocalPath(dir);
      loadLocalDir(dir);
    });
  }, []);

  useEffect(() => {
    remoteSeq.current += 1;
    setSelectedRemote(new Set());
    setLastRemoteIdx(-1);
    setRemoteView({ sessionId: activeSessionId, path: "/", files: [], busy: false });
    if (activeSessionId) void loadRemoteDir("/");
  }, [activeSessionId]);

  const loadLocalDir = async (dir: string) => {
    setLocalBusy(true);
    try {
      const files = await ListLocalDir(dir);
      setLocalFiles(files || []);
      setLocalPath(dir);
      setSelectedLocal(new Set());
      setLastLocalIdx(-1);
    } catch {}
    setLocalBusy(false);
  };

  const loadRemoteDir = async (dir: string) => {
    if (!active) return;
    const sessionId = active.id;
    if (sessionId !== remoteSessionRef.current) return;
    const seq = ++remoteSeq.current;
    setRemoteView((current) => ({
      sessionId,
      path: dir,
      files: current.sessionId === sessionId ? current.files : [],
      busy: true,
    }));
    try {
      const files = await ListRemoteDir(sessionId, dir);
      if (seq !== remoteSeq.current || remoteSessionRef.current !== sessionId) return;
      setRemoteView({ sessionId, path: dir, files: files || [], busy: false });
      setSelectedRemote(new Set());
      setLastRemoteIdx(-1);
    } catch {
      if (seq !== remoteSeq.current || remoteSessionRef.current !== sessionId) return;
      setRemoteView((current) => current.sessionId === sessionId ? { ...current, busy: false } : current);
    }
  };

  const onLocalClick = (idx: number, e: React.MouseEvent) => {
    const file = localFiles[idx];
    if (!file) return;
    if (e.shiftKey && lastLocalIdx >= 0) {
      const from = Math.min(lastLocalIdx, idx);
      const to = Math.max(lastLocalIdx, idx);
      const next = new Set(selectedLocal);
      for (let i = from; i <= to; i++) {
        if (!localFiles[i].isDir) next.add(localFiles[i].path);
      }
      setSelectedLocal(next);
    } else {
      const next = new Set<string>();
      if (!file.isDir) next.add(file.path);
      setSelectedLocal(next);
    }
    setLastLocalIdx(idx);
  };

  const onRemoteClick = (idx: number, e: React.MouseEvent) => {
    const file = remoteFiles[idx];
    if (!file) return;
    if (e.shiftKey && lastRemoteIdx >= 0) {
      const from = Math.min(lastRemoteIdx, idx);
      const to = Math.max(lastRemoteIdx, idx);
      const next = new Set(selectedRemote);
      for (let i = from; i <= to; i++) {
        if (!remoteFiles[i].isDir) next.add(remoteFiles[i].path);
      }
      setSelectedRemote(next);
    } else {
      const next = new Set<string>();
      if (!file.isDir) next.add(file.path);
      setSelectedRemote(next);
    }
    setLastRemoteIdx(idx);
  };

  const uploadSelected = async () => {
    if (!active || selectedLocal.size === 0) return;
    const sessionId = active.id;
    const files = localFiles.filter((f) => selectedLocal.has(f.path) && !f.isDir);
    // A few at a time rather than strictly serially: each file's round trip used
    // to leave the connection idle. The signal stops queueing new files if the
    // session changes underneath us, which the old loop did with its own check.
    const signal = { get cancelled() { return remoteSessionRef.current !== sessionId; } };
    await runQueue(files, async (file) => {
      const remoteTarget = remotePath.replace(/\/$/, "") + "/" + file.name;
      await UploadFile(sessionId, file.path, remoteTarget);
    }, { signal });
    if (remoteSessionRef.current !== sessionId) return;
    // Per-file failures are not reported here: every transfer already emits a
    // terminal sftp:progress event, which the history panel below renders with
    // the file name and error. The old serial loop swallowed them for the same
    // reason.
    loadRemoteDir(remotePath);
  };

  const downloadSelected = async () => {
    if (!active || selectedRemote.size === 0) return;
    const sessionId = active.id;
    const files = remoteFiles.filter((f) => selectedRemote.has(f.path) && !f.isDir);
    const signal = { get cancelled() { return remoteSessionRef.current !== sessionId; } };
    await runQueue(files, async (file) => {
      const localTarget = localPath.replace(/\/$/, "") + "/" + file.name;
      await DownloadFile(sessionId, file.path, localTarget);
    }, { signal });
    if (remoteSessionRef.current !== sessionId) return;
    loadLocalDir(localPath);
  };

  const activeTransfers = Object.entries(transfers).filter(([, transfer]) => transfer.sessionId === activeSessionId);
  const recentHistory = history.filter((item) => item.sessionId === activeSessionId).slice(0, 20);

  return (
    <FloatingCard center={initialLeft == null || initialTop == null} initialLeft={initialLeft} initialTop={initialTop} width={Math.min(860, typeof window !== "undefined" ? window.innerWidth - 32 : 860)} onClose={onClose}>
      <div className="transfer-modal-header">
        <span className="text-sm font-semibold">{t(lang, "transferTitle")}</span>
      </div>

      <div className="transfer-modal-body">
        <div className="transfer-panel">
          <div className="transfer-panel-header">
            <span className="text-xs font-semibold" style={{ color: "var(--accent)" }}>{t(lang, "local")}</span>
            <div className="transfer-path-row">
              <input className="transfer-input" value={localPath} onChange={(e) => setLocalPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadLocalDir(localPath)} />
              <button className="transfer-icon-btn" onClick={() => loadLocalDir(localPath)}><RefreshCw size={12} /></button>
            </div>
          </div>
          <div className="transfer-file-list">
            {localBusy && <div className="transfer-loading">{t(lang, "loading")}</div>}
            {!localBusy && localFiles.map((file, idx) => (
              <div
                key={file.path}
                className={clsx("transfer-file-item", selectedLocal.has(file.path) && "transfer-file-item-selected")}
                onClick={(e) => onLocalClick(idx, e)}
                onDoubleClick={() => file.isDir ? loadLocalDir(file.path) : undefined}
              >
                {file.isDir ? <Folder size={14} className="text-accent shrink-0" /> : <File size={14} className="text-muted shrink-0" />}
                <span className="min-w-0 flex-1 truncate text-xs">{file.name}</span>
                <span className="text-[10px] text-muted shrink-0">{file.isDir ? "" : formatFileSize(file.size)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="transfer-actions-col">
          <button className="transfer-action-btn" onClick={uploadSelected} disabled={selectedLocal.size === 0} title={t(lang, "upload")}>
            <ArrowUp size={16} />
          </button>
          <button className="transfer-action-btn" onClick={downloadSelected} disabled={selectedRemote.size === 0} title={t(lang, "download")}>
            <ArrowDown size={16} />
          </button>
        </div>

        <div className="transfer-panel">
          <div className="transfer-panel-header">
            <span className="text-xs font-semibold" style={{ color: "var(--accent)" }}>{t(lang, "remote")}</span>
            <div className="transfer-path-row">
              <input
                className="transfer-input"
                value={remotePath}
                onChange={(e) => setRemoteView((current) => ({ ...current, sessionId: activeSessionId, path: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && loadRemoteDir(remotePath)}
              />
              <button className="transfer-icon-btn" onClick={() => loadRemoteDir(remotePath)}><RefreshCw size={12} /></button>
            </div>
          </div>
          <div className="transfer-file-list">
            {remoteBusy && <div className="transfer-loading">{t(lang, "loading")}</div>}
            {!remoteBusy && remoteFiles.map((file, idx) => (
              <div
                key={file.path}
                className={clsx("transfer-file-item", selectedRemote.has(file.path) && "transfer-file-item-selected")}
                onClick={(e) => onRemoteClick(idx, e)}
                onDoubleClick={() => file.isDir ? loadRemoteDir(file.path) : undefined}
              >
                {file.isDir ? <Folder size={14} className="text-accent shrink-0" /> : <File size={14} className="text-muted shrink-0" />}
                <span className="min-w-0 flex-1 truncate text-xs">{file.name}</span>
                <span className="text-[10px] text-muted shrink-0">{file.isDir ? "" : formatFileSize(file.size)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {(activeTransfers.length > 0 || recentHistory.length > 0) && (
        <div className="transfer-progress-section">
          <div className="transfer-progress-header">
            <span className="text-[10px] font-semibold" style={{ color: "var(--muted)" }}>{t(lang, "transferProgress")}</span>
            {activeTransfers.length > 0 && <span className="text-[10px] text-accent">{activeTransfers.length}</span>}
          </div>
          {activeTransfers.map(([key, tr]) => {
            const pct = tr.total > 0 ? Math.round((tr.done / tr.total) * 100) : 0;
            const name = tr.path.split(/[\\/]/).pop() || tr.path;
            return (
              <div key={key} className="transfer-progress-item">
                {tr.direction === "upload" ? <ArrowUp size={11} className="text-accent shrink-0" /> : <ArrowDown size={11} className="text-accent shrink-0" />}
                <span className="min-w-0 flex-1 truncate text-[10px]">{name}</span>
                <div className="transfer-progress-bar-wrap">
                  <div className="transfer-progress-bar" style={{ width: `${pct}%` }} />
                </div>
                {/* Without this, a resumed transfer looks like one that
                    inexplicably started at 40%. */}
                {tr.resumedAt ? <span className="text-[9px] text-ok shrink-0">{t(lang, "transferResumed")}</span> : null}
                <span className="text-[9px] text-muted shrink-0 w-8 text-right tabular-nums">{pct}%</span>
                <button className="mini-btn" onClick={() => void cancelTransfer(tr.jobId)} title={t(lang, "cancel")}><X size={10} /></button>
              </div>
            );
          })}
          {recentHistory.map((h) => (
            <div key={h.key} className="transfer-progress-item" style={{ opacity: 0.5 }}>
              {h.direction === "upload" ? <ArrowUp size={11} className={h.ok ? "text-ok shrink-0" : "text-bad shrink-0"} /> : <ArrowDown size={11} className={h.ok ? "text-ok shrink-0" : "text-bad shrink-0"} />}
              <span className="min-w-0 flex-1 truncate text-[10px]">{h.name}</span>
              <span className={h.ok ? "text-[9px] text-ok shrink-0" : "text-[9px] text-bad shrink-0"} title={h.error}>
                {h.ok ? t(lang, "transferComplete") : h.status === "cancelled" ? t(lang, "transferCancelled") : t(lang, "transferFailed")}
              </span>
            </div>
          ))}
        </div>
      )}
    </FloatingCard>
  );
}
