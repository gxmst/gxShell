import { useEffect, useState } from "react";
import { ArrowUpDown, Copy, Download, Edit3, File, Folder, FolderDown, FolderPlus, RefreshCw, Trash2, Upload } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { CreateRemoteDir, DeleteRemoteFile, DownloadFile, DownloadFolder, RenameRemoteFile, SelectDownloadPath, SelectUploadFile, UploadFile } from "../../../wailsjs/go/main/App";
import type { Tab, Toast } from "../../types";
import { formatFileSize } from "../../utils/format";
import { ConfirmDialog } from "../modals/ConfirmDialog";
import { TextInputDialog } from "../modals/TextInputDialog";
import { TransferModal } from "../modals/TransferModal";
import { t } from "../../i18n";

type DialogState =
  | { type: "mkdir" }
  | { type: "rename"; file: types.RemoteFile }
  | { type: "delete"; file: types.RemoteFile }
  | null;

export function SftpPanel(props: { active?: Tab; path: string; files: types.RemoteFile[]; busy: boolean; locale?: string; onRefresh: (path?: string) => void; onNotify: (text: string, tone?: Toast["tone"]) => void; setCtxMenu: any }) {
  const { active, path, files, busy, locale, onRefresh, onNotify, setCtxMenu } = props;
  const [draftPath, setDraftPath] = useState(path);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [showTransfer, setShowTransfer] = useState(false);
  useEffect(() => setDraftPath(path), [path]);
  if (!active) return <div className="empty compact">{t(locale || "en", "connectFirstSftp")}</div>;

  const upload = async () => {
    try {
      const local = await SelectUploadFile();
      if (!local) return;
      const name = local.split(/[\\/]/).pop() || "upload.bin";
      await UploadFile(active.id, local, `${path.replace(/\/$/, "")}/${name}`);
      onRefresh(path);
    } catch (err) { onNotify(String(err), "error"); }
  };

  const download = async (file: types.RemoteFile) => {
    try {
      const target = await SelectDownloadPath(file.name);
      if (!target) return;
      await DownloadFile(active.id, file.path, target);
      onNotify("Download finished", "success");
    } catch (err) { onNotify(String(err), "error"); }
  };

  const downloadFolder = async (file: types.RemoteFile) => {
    try {
      const target = await SelectDownloadPath(file.name + ".d");
      if (!target) return;
      await DownloadFolder(active.id, file.path, target);
      onNotify("Folder download finished", "success");
    } catch (err) { onNotify(String(err), "error"); }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <input className="input compact-input" value={draftPath} onChange={(e) => setDraftPath(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onRefresh(draftPath)} />
        <button className="icon-btn compact-icon" onClick={() => onRefresh(draftPath)}><RefreshCw size={13} /></button>
        <button className="icon-btn compact-icon" onClick={upload}><Upload size={13} /></button>
        <button className="icon-btn compact-icon" onClick={() => setDialog({ type: "mkdir" })}><FolderPlus size={13} /></button>
        <button className="icon-btn compact-icon text-accent" onClick={() => setShowTransfer(true)} title={t(locale || "en", "transfer")}><ArrowUpDown size={13} /></button>
      </div>
      <div className="file-table">
        {busy && <div className="empty compact">Loading...</div>}
        {!busy && files.map((file) => (
          <div key={file.path} className="file-row" onDoubleClick={() => file.isDir ? onRefresh(file.path) : download(file)}>
            <span>{file.isDir ? <Folder size={14} className="text-accent" /> : <File size={14} className="text-muted" />}</span>
            <span className="min-w-0 flex-1 truncate">{file.name}</span>
            <span className="w-14 text-right text-muted">{file.isDir ? "dir" : formatFileSize(file.size)}</span>
            <div className="file-actions">
              {file.isDir ? (
                <button className="mini-btn bg-accent/10 border border-accent/30 hover:border-accent/50" onClick={() => downloadFolder(file)} title="Download folder"><FolderDown size={12} /></button>
              ) : (
                <button className="mini-btn bg-accent/10 border border-accent/30 hover:border-accent/50" onClick={() => download(file)} title="Download"><Download size={12} /></button>
              )}
              <button className="mini-btn" onClick={() => { navigator.clipboard?.writeText(file.path).then(() => onNotify("Copied to clipboard", "success")).catch(() => onNotify("Copy failed", "error")); }} title="Copy path"><Copy size={11} /></button>
              <button className="mini-btn" onClick={() => setDialog({ type: "rename", file })} title="Rename"><Edit3 size={11} /></button>
              <button className="mini-btn danger" onClick={() => setDialog({ type: "delete", file })} title="Delete"><Trash2 size={11} /></button>
            </div>
          </div>
        ))}
      </div>

      {dialog?.type === "mkdir" && <TextInputDialog title="New folder" label="Folder name" onClose={() => setDialog(null)} onSubmit={async (name) => { try { await CreateRemoteDir(active.id, `${path}/${name}`); setDialog(null); onRefresh(path); } catch (err) { onNotify(String(err), "error"); } }} />}
      {dialog?.type === "rename" && <TextInputDialog title="Rename file" label="New name" initialValue={dialog.file.name} onClose={() => setDialog(null)} onSubmit={async (name) => { try { await RenameRemoteFile(active.id, dialog.file.path, `${path}/${name}`); setDialog(null); onRefresh(path); } catch (err) { onNotify(String(err), "error"); } }} />}
      {dialog?.type === "delete" && <ConfirmDialog locale={locale} title="Delete remote file" body={`Delete ${dialog.file.name}? This cannot be undone.`} confirmText="Delete" onClose={() => setDialog(null)} onConfirm={async () => { try { await DeleteRemoteFile(active.id, dialog.file.path); setDialog(null); onRefresh(path); } catch (err) { onNotify(String(err), "error"); } }} />}

      {showTransfer && active && (
        <TransferModal active={active} locale={locale || "en"} initialLeft={280} initialTop={60} onClose={() => setShowTransfer(false)} />
      )}
    </div>
  );
}
