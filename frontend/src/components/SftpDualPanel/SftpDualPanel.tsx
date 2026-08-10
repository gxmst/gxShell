import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, File, Folder, RefreshCw } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { DownloadFileWithPolicy, ListLocalDir, LocalHomeDir, ListRemoteDir, UploadFileWithPolicy } from "../../../wailsjs/go/app/App";
import type { Tab, Toast } from "../../types";
import { formatFileSize } from "../../utils/format";
import { t } from "../../i18n";
import { ConfirmDialog } from "../modals/ConfirmDialog";

type PendingConflict = {
  direction: "upload" | "download";
  file: types.LocalFile | types.RemoteFile;
  sessionId: string;
  localDir: string;
  remoteDir: string;
  target: string;
};

export function SftpDualPanel({ active, locale, onNotify }: { active?: Tab; locale?: string; onNotify: (text: string, tone?: Toast["tone"]) => void }) {
  const lang = locale || "en";
  const activeSessionId = active?.id || "";
  const [localPath, setLocalPath] = useState("");
  const [localFiles, setLocalFiles] = useState<types.LocalFile[]>([]);
  const [localBusy, setLocalBusy] = useState(false);
  const [remoteView, setRemoteView] = useState<{ sessionId: string; path: string; files: types.RemoteFile[]; busy: boolean }>({ sessionId: "", path: "/", files: [], busy: false });
  const [selectedLocal, setSelectedLocal] = useState<string | null>(null);
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
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
    setSelectedRemote(null);
    setPendingConflict(null);
    setRemoteView({ sessionId: activeSessionId, path: "/", files: [], busy: false });
    if (activeSessionId) void loadRemoteDir("/");
  }, [activeSessionId]);

  useEffect(() => {
    if (!pendingConflict) return;
    if (pendingConflict.sessionId !== activeSessionId || pendingConflict.localDir !== localPath || pendingConflict.remoteDir !== remotePath) {
      setPendingConflict(null);
    }
  }, [activeSessionId, localPath, remotePath, pendingConflict]);

  const loadLocalDir = async (dir: string) => {
    setLocalBusy(true);
    try {
      const files = await ListLocalDir(dir);
      setLocalFiles(files || []);
      setLocalPath(dir);
    } catch (err) {
      onNotify(String(err), "error");
    }
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
      setSelectedRemote(null);
    } catch (err) {
      if (seq !== remoteSeq.current || remoteSessionRef.current !== sessionId) return;
      setRemoteView((current) => current.sessionId === sessionId ? { ...current, busy: false } : current);
      onNotify(String(err), "error");
    }
  };

  const uploadSelected = async (overwrite = false, pending: PendingConflict | null = null) => {
    if (!active || (!pending && !selectedLocal)) return;
    const sessionId = active.id;
    const file = (pending?.file as types.LocalFile | undefined) || localFiles.find((f) => f.path === selectedLocal);
    if (!file || file.isDir || !("path" in file)) return;
    try {
      const remoteTarget = pending?.target || remotePath.replace(/\/$/, "") + "/" + file.name;
      const existing = remoteFiles.find((entry) => entry.name === file.name);
      if (!overwrite && existing?.isDir) {
        onNotify(t(lang, "overwriteDirectoryBody", { names: file.name }), "error");
        return;
      }
      if (!overwrite && existing) {
        setPendingConflict({ direction: "upload", file, sessionId, localDir: localPath, remoteDir: remotePath, target: remoteTarget });
        return;
      }
      await UploadFileWithPolicy(sessionId, file.path, remoteTarget, overwrite);
      if (remoteSessionRef.current !== sessionId) return;
      onNotify(`${file.name} uploaded`, "success");
      loadRemoteDir(remotePath);
    } catch (err) {
      onNotify(String(err), "error");
    }
  };

  const downloadSelected = async (overwrite = false, pending: PendingConflict | null = null) => {
    if (!active || (!pending && !selectedRemote)) return;
    const file = (pending?.file as types.RemoteFile | undefined) || remoteFiles.find((f) => f.path === selectedRemote);
    if (!file || file.isDir || !("path" in file)) return;
    try {
      const localTarget = pending?.target || localPath.replace(/\/$/, "") + "/" + file.name;
      const existing = localFiles.find((entry) => entry.name === file.name);
      if (!overwrite && existing?.isDir) {
        onNotify(t(lang, "overwriteDirectoryBody", { names: file.name }), "error");
        return;
      }
      if (!overwrite && existing) {
        setPendingConflict({ direction: "download", file, sessionId: active.id, localDir: localPath, remoteDir: remotePath, target: localTarget });
        return;
      }
      await DownloadFileWithPolicy(active.id, file.path, localTarget, overwrite);
      onNotify(`${file.name} downloaded`, "success");
      loadLocalDir(localPath);
    } catch (err) {
      onNotify(String(err), "error");
    }
  };

  if (!active) return <div className="empty compact">{t(lang, "connectFirstSftp")}</div>;

  return (
    <div className="sftp-dual">
      <div className="sftp-dual-panel">
        <div className="sftp-dual-header">
          <span className="text-[10px] font-semibold text-accent">{t(lang, "local")}</span>
          <div className="sftp-dual-path-row">
            <input className="sftp-dual-input" value={localPath} onChange={(e) => setLocalPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadLocalDir(localPath)} />
            <button className="sftp-dual-icon-btn" onClick={() => loadLocalDir(localPath)}><RefreshCw size={11} /></button>
          </div>
        </div>
        <div className="sftp-dual-list">
          {localBusy && <div className="sftp-dual-loading">{t(lang, "loading")}</div>}
          {!localBusy && localFiles.map((file) => (
            <div
              key={file.path}
              className={clsx("sftp-dual-item", selectedLocal === file.path && "sftp-dual-item-selected")}
              onClick={() => setSelectedLocal(file.path)}
              onDoubleClick={() => file.isDir ? loadLocalDir(file.path) : undefined}
            >
              {file.isDir ? <Folder size={12} className="text-accent shrink-0" /> : <File size={12} className="text-muted shrink-0" />}
              <span className="min-w-0 flex-1 truncate text-[10px]">{file.name}</span>
              <span className="text-[9px] text-muted shrink-0">{file.isDir ? "" : formatFileSize(file.size)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="sftp-dual-actions">
        <button className="sftp-dual-transfer-btn" onClick={() => void uploadSelected()} disabled={!selectedLocal} title={t(lang, "upload")}>
          <ArrowUp size={12} />
        </button>
        <button className="sftp-dual-transfer-btn" onClick={() => void downloadSelected()} disabled={!selectedRemote} title={t(lang, "download")}>
          <ArrowDown size={12} />
        </button>
      </div>

      {pendingConflict && (
        <ConfirmDialog
          locale={lang}
          title={t(lang, "overwriteTitle")}
          body={t(lang, "overwriteBody", { names: pendingConflict.file.name })}
          confirmText={t(lang, "overwriteConfirm")}
          onClose={() => setPendingConflict(null)}
          onConfirm={() => {
            const pending = pendingConflict;
            if (pending.sessionId !== activeSessionId || pending.localDir !== localPath || pending.remoteDir !== remotePath) {
              setPendingConflict(null);
              return;
            }
            setPendingConflict(null);
            if (pending.direction === "upload") void uploadSelected(true, pending);
            else void downloadSelected(true, pending);
          }}
        />
      )}

      <div className="sftp-dual-panel">
        <div className="sftp-dual-header">
          <span className="text-[10px] font-semibold text-accent">{t(lang, "remote")}</span>
          <div className="sftp-dual-path-row">
            <input
              className="sftp-dual-input"
              value={remotePath}
              onChange={(e) => setRemoteView((current) => ({ ...current, sessionId: activeSessionId, path: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && loadRemoteDir(remotePath)}
            />
            <button className="sftp-dual-icon-btn" onClick={() => loadRemoteDir(remotePath)}><RefreshCw size={11} /></button>
          </div>
        </div>
        <div className="sftp-dual-list">
          {remoteBusy && <div className="sftp-dual-loading">{t(lang, "loading")}</div>}
          {!remoteBusy && remoteFiles.map((file) => (
            <div
              key={file.path}
              className={clsx("sftp-dual-item", selectedRemote === file.path && "sftp-dual-item-selected")}
              onClick={() => setSelectedRemote(file.path)}
              onDoubleClick={() => file.isDir ? loadRemoteDir(file.path) : undefined}
            >
              {file.isDir ? <Folder size={12} className="text-accent shrink-0" /> : <File size={12} className="text-muted shrink-0" />}
              <span className="min-w-0 flex-1 truncate text-[10px]">{file.name}</span>
              <span className="text-[9px] text-muted shrink-0">{file.isDir ? "" : formatFileSize(file.size)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
