import { useEffect, useState } from "react";
import { ArrowUpDown, Copy, Download, Edit3, File, FileText, Folder, FolderDown, FolderPlus, RefreshCw, Trash2, Upload } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { CreateRemoteDir, DeleteRemoteFile, DownloadFile, DownloadFolder, RenameRemoteFile, SelectDownloadPath, SelectUploadFile, UploadFile } from "../../../wailsjs/go/main/App";
import type { Tab, Toast } from "../../types";
import { formatFileSize } from "../../utils/format";
import { ConfirmDialog } from "../modals/ConfirmDialog";
import { TextInputDialog } from "../modals/TextInputDialog";
import { TransferModal } from "../modals/TransferModal";
import { t } from "../../i18n";
import { isSupportedTextPath } from "../../utils/textFiles";

type DialogState =
  | { type: "mkdir" }
  | { type: "rename"; file: types.RemoteFile }
  | { type: "delete"; file: types.RemoteFile }
  | null;

export function SftpPanel(props: { active?: Tab; path: string; files: types.RemoteFile[]; busy: boolean; locale?: string; onRefresh: (path?: string) => void; onNotify: (text: string, tone?: Toast["tone"]) => void; setCtxMenu: any; onOpenMarkdownFile?: (sessionId: string, path: string) => void }) {
  const { active, path, files, busy, locale, onRefresh, onNotify, setCtxMenu } = props;
  const lang = locale || "en";
  const [draftPath, setDraftPath] = useState(path);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [showTransfer, setShowTransfer] = useState(false);
  useEffect(() => setDraftPath(path), [path]);
  if (!active) return <div className="empty compact">{t(lang, "connectFirstSftp")}</div>;

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
      onNotify(t(lang, "downloadFinished"), "success");
    } catch (err) { onNotify(String(err), "error"); }
  };

  const downloadFolder = async (file: types.RemoteFile) => {
    try {
      const target = await SelectDownloadPath(file.name + ".d");
      if (!target) return;
      await DownloadFolder(active.id, file.path, target);
      onNotify(t(lang, "folderDownloadFinished"), "success");
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
        {busy && <div className="empty compact">{t(lang, "loading")}</div>}
        {!busy && files.map((file) => {
          const isTextFile = !file.isDir && isSupportedTextPath(file.name);
          return (
            <div key={file.path} className="file-row" onDoubleClick={() => file.isDir ? onRefresh(file.path) : isTextFile ? props.onOpenMarkdownFile?.(active.id, file.path) : download(file)}>
              <span>{file.isDir ? <Folder size={14} className="text-accent" /> : isTextFile ? <FileText size={14} className="text-accent" /> : <File size={14} className="text-muted" />}</span>
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <span className="w-14 text-right text-muted">{file.isDir ? "dir" : formatFileSize(file.size)}</span>
              <div className="file-actions">
                {isTextFile && (
                  <button className="mini-btn bg-accent/10 border border-accent/30 hover:border-accent/50" onClick={() => props.onOpenMarkdownFile?.(active.id, file.path)} title={t(lang, "openTextFile")}><FileText size={12} /></button>
                )}
                {file.isDir ? (
                  <button className="mini-btn bg-accent/10 border border-accent/30 hover:border-accent/50" onClick={() => downloadFolder(file)} title={t(lang, "downloadFolder")}><FolderDown size={12} /></button>
                ) : (
                <button className="mini-btn bg-accent/10 border border-accent/30 hover:border-accent/50" onClick={() => download(file)} title={t(lang, "download")}><Download size={12} /></button>
                )}
                <button className="mini-btn" onClick={() => { navigator.clipboard?.writeText(file.path).then(() => onNotify(t(lang, "copyToClipboard"), "success")).catch(() => onNotify(t(lang, "copyFailed"), "error")); }} title={t(lang, "copyPath")}><Copy size={11} /></button>
                <button className="mini-btn" onClick={() => setDialog({ type: "rename", file })} title={t(lang, "renameFile")}><Edit3 size={11} /></button>
                <button className="mini-btn danger" onClick={() => setDialog({ type: "delete", file })} title={t(lang, "delete")}><Trash2 size={11} /></button>
              </div>
            </div>
          );
        })}
      </div>

      {dialog?.type === "mkdir" && <TextInputDialog title={t(lang, "newFolder")} label={t(lang, "folderName")} onClose={() => setDialog(null)} onSubmit={async (name) => { try { await CreateRemoteDir(active.id, `${path}/${name}`); setDialog(null); onRefresh(path); } catch (err) { onNotify(String(err), "error"); } }} />}
      {dialog?.type === "rename" && <TextInputDialog title={t(lang, "renameFile")} label={t(lang, "newName")} initialValue={dialog.file.name} onClose={() => setDialog(null)} onSubmit={async (name) => { try { await RenameRemoteFile(active.id, dialog.file.path, `${path}/${name}`); setDialog(null); onRefresh(path); } catch (err) { onNotify(String(err), "error"); } }} />}
      {dialog?.type === "delete" && <ConfirmDialog locale={locale} title={t(lang, "deleteRemoteFile")} body={t(lang, "deleteRemoteFileBody", { name: dialog.file.name })} confirmText={t(lang, "delete")} onClose={() => setDialog(null)} onConfirm={async () => { try { await DeleteRemoteFile(active.id, dialog.file.path); setDialog(null); onRefresh(path); } catch (err) { onNotify(String(err), "error"); } }} />}

      {showTransfer && active && (
        <TransferModal active={active} locale={lang} initialLeft={280} initialTop={60} onClose={() => setShowTransfer(false)} />
      )}
    </div>
  );
}
