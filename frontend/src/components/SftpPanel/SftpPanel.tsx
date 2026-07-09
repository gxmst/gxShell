import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  ArrowUp,
  ChevronRight,
  Columns2,
  Copy,
  Download,
  Edit3,
  File,
  FileText,
  Folder,
  FolderDown,
  FolderOpen,
  FolderPlus,
  Home,
  RefreshCw,
  Terminal,
  Trash2,
  Upload,
  ArrowUpDown,
} from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import {
  CreateRemoteDir,
  DeleteRemoteFile,
  DownloadFile,
  DownloadFolder,
  ListRemoteDir,
  RenameRemoteFile,
  SelectDownloadPath,
  SelectUploadFile,
  UploadFile,
} from "../../../wailsjs/go/main/App";
import type { Tab, Toast } from "../../types";
import { formatFileSize } from "../../utils/format";
import { joinRemotePath, parentRemotePath, pathSegments } from "../../utils/shellQuote";
import { isSupportedTextPath } from "../../utils/textFiles";
import { useTransfers } from "../../hooks/useTransfers";
import { ConfirmDialog } from "../modals/ConfirmDialog";
import { TextInputDialog } from "../modals/TextInputDialog";
import { TransferModal } from "../modals/TransferModal";
import { TransferCenter } from "./TransferCenter";
import { t } from "../../i18n";

type DialogState =
  | { type: "mkdir" }
  | { type: "rename"; file: types.RemoteFile }
  | { type: "delete"; file: types.RemoteFile }
  | null;

type PathSuggest = { path: string; name: string; source: "cwd" | "parent" | "segment" };

function parsePathInput(input: string): { base: string; prefix: string; absolute: boolean } {
  const raw = input || "";
  const absolute = raw.startsWith("/");
  if (raw.endsWith("/") || raw === "") {
    const base = raw === "" || raw === "/" ? (absolute || raw === "/" ? "/" : ".") : raw.replace(/\/+$/, "") || "/";
    return { base: base === "" ? "/" : base, prefix: "", absolute };
  }
  const idx = raw.lastIndexOf("/");
  if (idx < 0) return { base: ".", prefix: raw, absolute: false };
  if (idx === 0) return { base: "/", prefix: raw.slice(1), absolute: true };
  return { base: raw.slice(0, idx), prefix: raw.slice(idx + 1), absolute };
}

export function SftpPanel(props: {
  active?: Tab;
  path: string;
  files: types.RemoteFile[];
  busy: boolean;
  locale?: string;
  onRefresh: (path?: string) => void;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
  setCtxMenu: any;
  onOpenMarkdownFile?: (sessionId: string, path: string) => void;
  /** Send `cd` into the active terminal and focus it. */
  onOpenTerminalInDir?: (sessionId: string, path: string) => void;
}) {
  const { active, path, files, busy, locale, onRefresh, onNotify } = props;
  const lang = locale || "en";
  const { activeCount } = useTransfers();

  const [draftPath, setDraftPath] = useState(path);
  const [pathFocus, setPathFocus] = useState(false);
  const [suggestDirs, setSuggestDirs] = useState<types.RemoteFile[]>([]);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [panel, setPanel] = useState<"manager" | "explorer" | null>(null);
  const [filter, setFilter] = useState("");
  const pathWrapRef = useRef<HTMLDivElement>(null);
  const suggestSeq = useRef(0);

  useEffect(() => setDraftPath(path), [path]);

  // Close suggestions when clicking outside.
  useEffect(() => {
    if (!pathFocus) return;
    const onDoc = (e: MouseEvent) => {
      if (!pathWrapRef.current?.contains(e.target as Node)) setPathFocus(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [pathFocus]);

  const { base: suggestBase, prefix: suggestPrefix } = useMemo(
    () => parsePathInput(draftPath),
    [draftPath],
  );

  // Load directory listing for autocomplete base path.
  useEffect(() => {
    if (!pathFocus || !active || active.type === "markdown") return;
    const base = suggestBase || ".";
    // Current listing is enough when suggesting under the open folder.
    if (base === path || base === path.replace(/\/$/, "") || (base === "." && (path === "." || path === ""))) {
      setSuggestDirs(files.filter((f) => f.isDir));
      return;
    }
    const seq = ++suggestSeq.current;
    setSuggestBusy(true);
    ListRemoteDir(active.id, base)
      .then((list) => {
        if (seq !== suggestSeq.current) return;
        setSuggestDirs((list || []).filter((f) => f.isDir));
      })
      .catch(() => {
        if (seq !== suggestSeq.current) return;
        setSuggestDirs([]);
      })
      .finally(() => {
        if (seq === suggestSeq.current) setSuggestBusy(false);
      });
  }, [pathFocus, suggestBase, active?.id, active?.type, path, files]);

  const suggestions = useMemo(() => {
    const out: PathSuggest[] = [];
    const q = suggestPrefix.toLowerCase();
    const dirs = suggestDirs
      .filter((d) => !q || d.name.toLowerCase().includes(q) || d.name.toLowerCase().startsWith(q))
      .slice(0, 24);
    for (const d of dirs) {
      out.push({ path: d.path, name: d.name, source: "cwd" });
    }
    // When input is empty / root-ish, offer quick anchors from current tree.
    if (!draftPath || draftPath === "." || draftPath === "/") {
      const segs = pathSegments(path);
      for (const s of segs.slice(0, 6)) {
        if (!out.some((x) => x.path === s.path)) {
          out.push({ path: s.path, name: s.label, source: "segment" });
        }
      }
    }
    return out;
  }, [suggestDirs, suggestPrefix, draftPath, path]);

  const breadcrumbs = useMemo(() => pathSegments(path), [path]);

  const visibleFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = [...files].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    if (!q) return list;
    return list.filter((f) => f.name.toLowerCase().includes(q));
  }, [files, filter]);

  const goTo = useCallback(
    (next: string) => {
      setDraftPath(next);
      setPathFocus(false);
      onRefresh(next);
    },
    [onRefresh],
  );

  const goUp = () => goTo(parentRemotePath(path));

  const upload = async () => {
    if (!active) return;
    try {
      const local = await SelectUploadFile();
      if (!local) return;
      const name = local.split(/[\\/]/).pop() || "upload.bin";
      await UploadFile(active.id, local, joinRemotePath(path, name));
      onRefresh(path);
      setPanel("manager");
    } catch (err) {
      onNotify(String(err), "error");
    }
  };

  const download = async (file: types.RemoteFile) => {
    if (!active) return;
    try {
      const target = await SelectDownloadPath(file.name);
      if (!target) return;
      await DownloadFile(active.id, file.path, target);
      onNotify(t(lang, "downloadFinished"), "success");
      setPanel("manager");
    } catch (err) {
      onNotify(String(err), "error");
    }
  };

  const downloadFolder = async (file: types.RemoteFile) => {
    if (!active) return;
    try {
      const target = await SelectDownloadPath(file.name + ".d");
      if (!target) return;
      await DownloadFolder(active.id, file.path, target);
      onNotify(t(lang, "folderDownloadFinished"), "success");
      setPanel("manager");
    } catch (err) {
      onNotify(String(err), "error");
    }
  };

  const openTerminalHere = () => {
    if (!active) return;
    if (props.onOpenTerminalInDir) {
      props.onOpenTerminalInDir(active.id, path);
      onNotify(t(lang, "openTerminalInDirDone", { path }), "info");
      return;
    }
    onNotify(t(lang, "openTerminalInDirDone", { path }), "info");
  };

  if (!active) return <div className="empty compact">{t(lang, "connectFirstSftp")}</div>;

  return (
    <div className="sftp-panel">
      {/* Path navigator */}
      <div className="sftp-pathbar" ref={pathWrapRef}>
        <div className="sftp-path-input-row">
          <button className="icon-btn compact-icon" onClick={goUp} title={t(lang, "parentDir")} disabled={path === "/" }>
            <ArrowUp size={13} />
          </button>
          <button className="icon-btn compact-icon" onClick={() => goTo("/")} title={t(lang, "goHomeRoot")}>
            <Home size={13} />
          </button>
          <div className="sftp-path-field">
            <input
              className="input compact-input sftp-path-input"
              value={draftPath}
              onChange={(e) => setDraftPath(e.target.value)}
              onFocus={() => setPathFocus(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  goTo(draftPath.trim() || ".");
                }
                if (e.key === "Escape") {
                  setDraftPath(path);
                  setPathFocus(false);
                }
                if (e.key === "ArrowDown" && suggestions[0]) {
                  e.preventDefault();
                  // focus first suggestion via selecting it on next enter — go to first
                }
              }}
              placeholder={t(lang, "pathPlaceholder")}
              spellCheck={false}
              autoComplete="off"
            />
            {pathFocus && (
              <div className="sftp-suggest">
                <div className="sftp-suggest-head">
                  <FolderOpen size={12} />
                  <span>
                    {suggestBusy
                      ? t(lang, "loading")
                      : t(lang, "pathSuggestions", { path: suggestBase || path })}
                  </span>
                </div>
                {suggestions.length === 0 && !suggestBusy && (
                  <div className="sftp-suggest-empty">{t(lang, "noPathSuggestions")}</div>
                )}
                {suggestions.map((s) => (
                  <button
                    key={`${s.source}-${s.path}`}
                    type="button"
                    className="sftp-suggest-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => goTo(s.path)}
                  >
                    <Folder size={13} className="text-accent shrink-0" />
                    <span className="sftp-suggest-name">{s.name}</span>
                    <span className="sftp-suggest-path">{s.path}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button className="icon-btn compact-icon" onClick={() => goTo(draftPath.trim() || path)} title={t(lang, "refresh")} disabled={busy}>
            <RefreshCw size={13} className={clsx(busy && "sftp-spin")} />
          </button>
        </div>

        <div className="sftp-crumbs">
          {breadcrumbs.map((seg, i) => (
            <span key={seg.path + i} className="sftp-crumb-wrap">
              {i > 0 && <ChevronRight size={11} className="sftp-crumb-sep" />}
              <button
                type="button"
                className={clsx("sftp-crumb", i === breadcrumbs.length - 1 && "sftp-crumb-current")}
                onClick={() => goTo(seg.path)}
                title={seg.path}
              >
                {seg.label}
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Toolbar */}
      <div className="sftp-toolbar">
        <button className="sftp-tool-btn" onClick={upload} title={t(lang, "upload")}>
          <Upload size={13} /> <span>{t(lang, "upload")}</span>
        </button>
        <button className="sftp-tool-btn" onClick={() => setDialog({ type: "mkdir" })} title={t(lang, "newFolder")}>
          <FolderPlus size={13} /> <span>{t(lang, "newFolder")}</span>
        </button>
        <button
          className={clsx("sftp-tool-btn", activeCount > 0 && "sftp-tool-btn-accent")}
          onClick={() => setPanel("manager")}
          title={t(lang, "transferManager")}
        >
          <ArrowUpDown size={13} />
          <span>{t(lang, "transfer")}</span>
          {activeCount > 0 && <span className="sftp-badge">{activeCount}</span>}
        </button>
        <button className="sftp-tool-btn" onClick={() => setPanel("explorer")} title={t(lang, "dualPaneTransfer")}>
          <Columns2 size={13} /> <span>{t(lang, "dualPaneShort")}</span>
        </button>
        <div className="sftp-toolbar-spacer" />
        <input
          className="input compact-input sftp-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t(lang, "filterFiles")}
        />
      </div>

      {/* File list */}
      <div className="sftp-file-table">
        <div className="sftp-file-head">
          <span className="sftp-col-name">{t(lang, "name")}</span>
          <span className="sftp-col-size">{t(lang, "fileSizeCol")}</span>
          <span className="sftp-col-actions" />
        </div>
        <div className="sftp-file-body">
          {busy && <div className="empty compact">{t(lang, "loading")}</div>}
          {!busy && visibleFiles.length === 0 && (
            <div className="empty compact">{filter ? t(lang, "noMatchingFiles") : t(lang, "emptyFolder")}</div>
          )}
          {!busy &&
            visibleFiles.map((file) => {
              const isTextFile = !file.isDir && isSupportedTextPath(file.name);
              return (
                <div
                  key={file.path}
                  className="sftp-file-row"
                  onDoubleClick={() =>
                    file.isDir
                      ? goTo(file.path)
                      : isTextFile
                        ? props.onOpenMarkdownFile?.(active.id, file.path)
                        : download(file)
                  }
                  onContextMenu={(e) => {
                    e.preventDefault();
                    props.setCtxMenu?.({
                      x: e.clientX,
                      y: e.clientY,
                      items: [
                        ...(file.isDir
                          ? [
                              { label: t(lang, "open"), action: () => goTo(file.path) },
                              { label: t(lang, "downloadFolder"), action: () => downloadFolder(file) },
                            ]
                          : [
                              ...(isTextFile
                                ? [{ label: t(lang, "openTextFile"), action: () => props.onOpenMarkdownFile?.(active.id, file.path) }]
                                : []),
                              { label: t(lang, "download"), action: () => download(file) },
                            ]),
                        { label: t(lang, "copyPath"), action: () => {
                          navigator.clipboard?.writeText(file.path)
                            .then(() => onNotify(t(lang, "copyToClipboard"), "success"))
                            .catch(() => onNotify(t(lang, "copyFailed"), "error"));
                        }},
                        { label: t(lang, "renameFile"), action: () => setDialog({ type: "rename", file }) },
                        { label: t(lang, "delete"), action: () => setDialog({ type: "delete", file }), danger: true },
                      ],
                    });
                  }}
                >
                  <span className="sftp-file-icon">
                    {file.isDir ? (
                      <Folder size={14} className="text-accent" />
                    ) : isTextFile ? (
                      <FileText size={14} className="text-accent" />
                    ) : (
                      <File size={14} className="text-muted" />
                    )}
                  </span>
                  <span className="sftp-file-name" title={file.path}>{file.name}</span>
                  <span className="sftp-file-size">{file.isDir ? "—" : formatFileSize(file.size)}</span>
                  <div className="sftp-file-actions">
                    {isTextFile && (
                      <button className="mini-btn" onClick={() => props.onOpenMarkdownFile?.(active.id, file.path)} title={t(lang, "openTextFile")}>
                        <FileText size={12} />
                      </button>
                    )}
                    {file.isDir ? (
                      <button className="mini-btn" onClick={() => downloadFolder(file)} title={t(lang, "downloadFolder")}>
                        <FolderDown size={12} />
                      </button>
                    ) : (
                      <button className="mini-btn" onClick={() => download(file)} title={t(lang, "download")}>
                        <Download size={12} />
                      </button>
                    )}
                    <button
                      className="mini-btn"
                      onClick={() => {
                        navigator.clipboard?.writeText(file.path)
                          .then(() => onNotify(t(lang, "copyToClipboard"), "success"))
                          .catch(() => onNotify(t(lang, "copyFailed"), "error"));
                      }}
                      title={t(lang, "copyPath")}
                    >
                      <Copy size={11} />
                    </button>
                    <button className="mini-btn" onClick={() => setDialog({ type: "rename", file })} title={t(lang, "renameFile")}>
                      <Edit3 size={11} />
                    </button>
                    <button className="mini-btn danger" onClick={() => setDialog({ type: "delete", file })} title={t(lang, "delete")}>
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              );
            })}
        </div>
      </div>

      {/* Footer: open terminal in this directory */}
      <div className="sftp-footer">
        <button className="sftp-terminal-btn" onClick={openTerminalHere} title={t(lang, "openTerminalInDir")}>
          <Terminal size={14} />
          <span>{t(lang, "openTerminalInDir")}</span>
          <code className="sftp-terminal-path">{path}</code>
        </button>
      </div>

      {dialog?.type === "mkdir" && (
        <TextInputDialog
          title={t(lang, "newFolder")}
          label={t(lang, "folderName")}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            try {
              await CreateRemoteDir(active.id, joinRemotePath(path, name));
              setDialog(null);
              onRefresh(path);
            } catch (err) {
              onNotify(String(err), "error");
            }
          }}
        />
      )}
      {dialog?.type === "rename" && (
        <TextInputDialog
          title={t(lang, "renameFile")}
          label={t(lang, "newName")}
          initialValue={dialog.file.name}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            try {
              await RenameRemoteFile(active.id, dialog.file.path, joinRemotePath(path, name));
              setDialog(null);
              onRefresh(path);
            } catch (err) {
              onNotify(String(err), "error");
            }
          }}
        />
      )}
      {dialog?.type === "delete" && (
        <ConfirmDialog
          locale={locale}
          title={t(lang, "deleteRemoteFile")}
          body={t(lang, "deleteRemoteFileBody", { name: dialog.file.name })}
          confirmText={t(lang, "delete")}
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await DeleteRemoteFile(active.id, dialog.file.path);
              setDialog(null);
              onRefresh(path);
            } catch (err) {
              onNotify(String(err), "error");
            }
          }}
        />
      )}

      {panel === "manager" && (
        <TransferCenter
          locale={lang}
          sessionId={active.id}
          onClose={() => setPanel(null)}
          onOpenExplorer={() => setPanel("explorer")}
          onUpload={upload}
        />
      )}
      {panel === "explorer" && (
        <TransferModal
          active={active}
          locale={lang}
          onClose={() => setPanel(null)}
        />
      )}
    </div>
  );
}
