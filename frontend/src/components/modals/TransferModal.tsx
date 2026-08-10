import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { AlertTriangle, ArrowDown, ArrowUp, File, Folder, RefreshCw, X } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { DownloadFileWithPolicy, ListLocalDir, LocalHomeDir, ListRemoteDir, UploadFileWithPolicy } from "../../../wailsjs/go/app/App";
import { useTransfers } from "../../hooks/useTransfers";
import { isWindowsPlatform } from "../../utils/clipboard";
import { formatFileSize } from "../../utils/format";
import { excludeTransferNames, findTransferConflicts } from "../../utils/transferConflict";
import { runQueue } from "../../utils/transferQueue";
import { t } from "../../i18n";
import { FloatingCard } from "../FloatingCard/FloatingCard";
import { DialogHeader, ModalShell } from "./ModalShell";

type TransferContext = {
  sessionId: string;
  localPath: string;
  remotePath: string;
};

type PendingConflict = {
  direction: "upload" | "download";
  context: TransferContext;
  files: (types.LocalFile | types.RemoteFile)[];
  replaceable: string[];
  directories: string[];
  caseInsensitive: boolean;
};

const transferNameKey = (name: string, caseInsensitive: boolean) => (
  caseInsensitive ? name.toLowerCase() : name
);

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
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
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
  const localPathRef = useRef(localPath);
  const remotePathRef = useRef(remotePath);
  localPathRef.current = localPath;
  remotePathRef.current = remotePath;

  const contextIsCurrent = (context: TransferContext) => (
    remoteSessionRef.current === context.sessionId
    && localPathRef.current === context.localPath
    && remotePathRef.current === context.remotePath
  );

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

  useEffect(() => {
    setConflict(null);
  }, [activeSessionId, localPath, remotePath]);

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

  const runUpload = async (files: types.LocalFile[], context: TransferContext, overwriteNames: readonly string[]) => {
    if (!context.sessionId || files.length === 0) return;
    const sessionId = context.sessionId;
    const overwriteSet = new Set(overwriteNames);
    // A few at a time rather than strictly serially: each file's round trip used
    // to leave the connection idle. The signal stops queueing new files if the
    // session changes underneath us, which the old loop did with its own check.
    const signal = { get cancelled() { return remoteSessionRef.current !== sessionId; } };
    await runQueue(files, async (file) => {
      const remoteTarget = context.remotePath.replace(/\/$/, "") + "/" + file.name;
      await UploadFileWithPolicy(sessionId, file.path, remoteTarget, overwriteSet.has(file.name));
    }, { signal });
    if (!contextIsCurrent(context)) return;
    // Per-file failures are not reported here: every transfer already emits a
    // terminal sftp:progress event, which the history panel below renders with
    // the file name and error. The old serial loop swallowed them for the same
    // reason.
    loadRemoteDir(context.remotePath);
  };

  const runDownload = async (
    files: types.RemoteFile[],
    context: TransferContext,
    overwriteNames: readonly string[],
    caseInsensitive: boolean,
  ) => {
    if (!context.sessionId || files.length === 0) return;
    const sessionId = context.sessionId;
    const overwriteSet = new Set(overwriteNames.map((name) => transferNameKey(name, caseInsensitive)));
    const signal = { get cancelled() { return remoteSessionRef.current !== sessionId; } };
    await runQueue(files, async (file) => {
      const localTarget = context.localPath.replace(/\/$/, "") + "/" + file.name;
      const overwrite = overwriteSet.has(transferNameKey(file.name, caseInsensitive));
      await DownloadFileWithPolicy(sessionId, file.path, localTarget, overwrite);
    }, { signal });
    if (!contextIsCurrent(context)) return;
    loadLocalDir(context.localPath);
  };

  // Both directory listings are already in state, so a same-name collision is
  // detectable without asking the backend. Transfers used to start immediately
  // and silently replace whatever sat at the destination.
  const startTransfer = (direction: "upload" | "download") => {
    const context = { sessionId: activeSessionId, localPath, remotePath };
    if (direction === "upload") {
      const files = localFiles.filter((f) => selectedLocal.has(f.path) && !f.isDir);
      if (files.length === 0) return;
      const { replaceable, directories } = findTransferConflicts(files, remoteFiles);
      if (replaceable.length > 0 || directories.length > 0) {
        setConflict({ direction, context, files, replaceable, directories, caseInsensitive: false });
        return;
      }
      void runUpload(files, context, []);
      return;
    }
    const files = remoteFiles.filter((f) => selectedRemote.has(f.path) && !f.isDir);
    if (files.length === 0) return;
    const caseInsensitive = isWindowsPlatform();
    const { replaceable, directories } = findTransferConflicts(files, localFiles, caseInsensitive);
    if (replaceable.length > 0 || directories.length > 0) {
      setConflict({ direction, context, files, replaceable, directories, caseInsensitive });
      return;
    }
    void runDownload(files, context, [], caseInsensitive);
  };

  const resolveConflict = (mode: "overwrite" | "skip") => {
    const pending = conflict;
    setConflict(null);
    if (!pending || !contextIsCurrent(pending.context)) return;
    const excluded = mode === "overwrite"
      ? pending.directories
      : [...pending.replaceable, ...pending.directories];
    const overwriteNames = mode === "overwrite" ? pending.replaceable : [];
    if (pending.direction === "upload") {
      const files = pending.files as types.LocalFile[];
      void runUpload(excludeTransferNames(files, excluded), pending.context, overwriteNames);
    } else {
      const files = pending.files as types.RemoteFile[];
      void runDownload(
        excludeTransferNames(files, excluded, pending.caseInsensitive),
        pending.context,
        overwriteNames,
        pending.caseInsensitive,
      );
    }
  };

  // The collision prompt. Three outcomes rather than the usual two, so this
  // does not reuse ConfirmDialog: cancel keeps the selection untouched, skip
  // transfers only non-clashing files, and overwrite still rejects folders.
  const conflictDialog = conflict && (
    <ModalShell onClose={() => setConflict(null)} compact ariaLabel={t(lang, "overwriteTitle")}>
      <DialogHeader icon={<AlertTriangle size={15} />} title={t(lang, "overwriteTitle")} />
      {conflict.replaceable.length > 0 && (
        <div className="dialog-body-copy">
          {t(lang, "overwriteBody", { names: conflict.replaceable.join(", ") })}
        </div>
      )}
      {conflict.directories.length > 0 && (
        <div className="dialog-body-copy">
          {t(lang, "overwriteDirectoryBody", { names: conflict.directories.join(", ") })}
        </div>
      )}
      <div className="dialog-footer">
        <button className="btn-secondary" onClick={() => setConflict(null)}>{t(lang, "cancel")}</button>
        <button className="btn-secondary" onClick={() => resolveConflict("skip")}>{t(lang, "overwriteSkip")}</button>
        {conflict.replaceable.length > 0 && (
          <button className="btn-danger" onClick={() => resolveConflict("overwrite")}>{t(lang, "overwriteConfirm")}</button>
        )}
      </div>
    </ModalShell>
  );

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
          <button className="transfer-action-btn" onClick={() => startTransfer("upload")} disabled={selectedLocal.size === 0} title={t(lang, "upload")}>
            <ArrowUp size={16} />
          </button>
          <button className="transfer-action-btn" onClick={() => startTransfer("download")} disabled={selectedRemote.size === 0} title={t(lang, "download")}>
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
      {conflictDialog}
    </FloatingCard>
  );
}
