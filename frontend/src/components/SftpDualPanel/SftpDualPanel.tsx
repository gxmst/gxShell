import { useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowDown, ArrowUp, File, Folder, RefreshCw } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ListLocalDir, LocalHomeDir, ListRemoteDir, UploadFile, DownloadFile } from "../../../wailsjs/go/main/App";
import type { Tab, Toast } from "../../types";
import { formatFileSize } from "../../utils/format";
import { t } from "../../i18n";

export function SftpDualPanel({ active, locale, onNotify }: { active?: Tab; locale?: string; onNotify: (text: string, tone?: Toast["tone"]) => void }) {
  const lang = locale || "en";
  const [localPath, setLocalPath] = useState("");
  const [remotePath, setRemotePath] = useState("/");
  const [localFiles, setLocalFiles] = useState<types.LocalFile[]>([]);
  const [remoteFiles, setRemoteFiles] = useState<types.RemoteFile[]>([]);
  const [localBusy, setLocalBusy] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [selectedLocal, setSelectedLocal] = useState<string | null>(null);
  const [selectedRemote, setSelectedRemote] = useState<string | null>(null);

  useEffect(() => {
    LocalHomeDir().then((dir) => {
      setLocalPath(dir);
      loadLocalDir(dir);
    });
  }, []);

  useEffect(() => {
    if (active) {
      loadRemoteDir(remotePath);
    }
  }, [active]);

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
    setRemoteBusy(true);
    try {
      const files = await ListRemoteDir(active.id, dir);
      setRemoteFiles(files || []);
      setRemotePath(dir);
    } catch (err) {
      onNotify(String(err), "error");
    }
    setRemoteBusy(false);
  };

  const uploadSelected = async () => {
    if (!active || !selectedLocal) return;
    const file = localFiles.find((f) => f.path === selectedLocal);
    if (!file || file.isDir) return;
    try {
      const remoteTarget = remotePath.replace(/\/$/, "") + "/" + file.name;
      await UploadFile(active.id, file.path, remoteTarget);
      onNotify(`${file.name} uploaded`, "success");
      loadRemoteDir(remotePath);
    } catch (err) {
      onNotify(String(err), "error");
    }
  };

  const downloadSelected = async () => {
    if (!active || !selectedRemote) return;
    const file = remoteFiles.find((f) => f.path === selectedRemote);
    if (!file || file.isDir) return;
    try {
      const localTarget = localPath.replace(/\/$/, "") + "/" + file.name;
      await DownloadFile(active.id, file.path, localTarget);
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
        <button className="sftp-dual-transfer-btn" onClick={uploadSelected} disabled={!selectedLocal} title={t(lang, "upload")}>
          <ArrowUp size={12} />
        </button>
        <button className="sftp-dual-transfer-btn" onClick={downloadSelected} disabled={!selectedRemote} title={t(lang, "download")}>
          <ArrowDown size={12} />
        </button>
      </div>

      <div className="sftp-dual-panel">
        <div className="sftp-dual-header">
          <span className="text-[10px] font-semibold text-accent">{t(lang, "remote")}</span>
          <div className="sftp-dual-path-row">
            <input className="sftp-dual-input" value={remotePath} onChange={(e) => setRemotePath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && loadRemoteDir(remotePath)} />
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
