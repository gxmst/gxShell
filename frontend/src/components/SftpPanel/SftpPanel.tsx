import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Columns2,
  Download,
  File,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  MoreHorizontal,
  RefreshCw,
  Search,
  Terminal,
  Upload,
  ArrowUpDown,
  X,
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
import type { AppContextMenu } from "../../hooks/useTerminal";
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
type SortKey = "name" | "size" | "modified";

function modifiedTime(value: unknown): number {
  const time = new Date(value as string).getTime();
  return Number.isFinite(time) ? time : 0;
}

function formatModified(value: unknown, formatter: Intl.DateTimeFormat): string {
  const time = modifiedTime(value);
  if (!time) return "—";
  return formatter.format(new Date(time));
}

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

// Windowed rendering constants: rows are fixed-height (see .sftp-file-row
// min-height in sftp.css); the fallback is used until the first row has been
// measured. Overscan keeps scrolling smooth between rAF-throttled updates.
const ROW_HEIGHT_FALLBACK = 35;
const OVERSCAN_ROWS = 10;

type FileRowActions = {
  select: (file: types.RemoteFile) => void;
  open: (file: types.RemoteFile) => void;
  menu: (file: types.RemoteFile, x: number, y: number) => void;
  openDir: (file: types.RemoteFile) => void;
  openText: (file: types.RemoteFile) => void;
  download: (file: types.RemoteFile) => void;
};

// One file-list row. Memoized so the rAF-throttled scrollTop updates that
// re-render SftpPanel while scrolling do not re-render every mounted row;
// the action callbacks passed in are identity-stable trampolines.
const FileRow = memo(function FileRow(props: {
  file: types.RemoteFile;
  selected: boolean;
  lang: string;
  formatter: Intl.DateTimeFormat;
  onSelect: (file: types.RemoteFile) => void;
  onOpen: (file: types.RemoteFile) => void;
  onMenu: (file: types.RemoteFile, x: number, y: number) => void;
  onOpenDir: (file: types.RemoteFile) => void;
  onOpenText: (file: types.RemoteFile) => void;
  onDownload: (file: types.RemoteFile) => void;
}) {
  const { file, lang } = props;
  const isTextFile = !file.isDir && isSupportedTextPath(file.name);
  return (
    <div
      className={clsx("sftp-file-row", props.selected && "selected")}
      tabIndex={0}
      onClick={() => props.onSelect(file)}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        props.onOpen(file);
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && event.key === "Enter") props.onOpen(file);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        props.onMenu(file, e.clientX, e.clientY);
      }}
    >
      <span className="sftp-file-main">
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
      </span>
      <span className="sftp-file-size">{file.isDir ? "—" : formatFileSize(file.size)}</span>
      <span className="sftp-file-modified">{formatModified(file.modTime, props.formatter)}</span>
      <div className="sftp-file-actions">
        {file.isDir ? (
          <button className="mini-btn" onClick={(event) => { event.stopPropagation(); props.onOpenDir(file); }} title={t(lang, "open")}>
            <ChevronRight size={12} />
          </button>
        ) : isTextFile ? (
          <button className="mini-btn" onClick={(event) => { event.stopPropagation(); props.onOpenText(file); }} title={t(lang, "openTextFile")}><FileText size={12} /></button>
        ) : (
          <button className="mini-btn" onClick={(event) => { event.stopPropagation(); props.onDownload(file); }} title={t(lang, "download")}>
            <Download size={12} />
          </button>
        )}
        <button
          className="mini-btn"
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            props.onMenu(file, rect.right, rect.bottom + 3);
          }}
          title={lang === "zh-CN" ? "更多操作" : "More actions"}
        >
          <MoreHorizontal size={12} />
        </button>
      </div>
    </div>
  );
});

export function SftpPanel(props: {
  active?: Tab;
  path: string;
  files: types.RemoteFile[];
  busy: boolean;
  locale?: string;
  onRefresh: (path?: string) => void;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
  setCtxMenu?: (menu: AppContextMenu | null) => void;
  onOpenMarkdownFile?: (sessionId: string, path: string) => void;
  /** Send `cd` into the active terminal and focus it. */
  onOpenTerminalInDir?: (sessionId: string, path: string) => void;
}) {
  const { active, path, files, busy, locale, onRefresh, onNotify } = props;
  const lang = locale || "en";
  const activeSessionId = active?.id || "";
  const { activeCount } = useTransfers();

  const [draftPathState, setDraftPathState] = useState({ sessionId: activeSessionId, value: path });
  const [pathFocus, setPathFocus] = useState(false);
  const [suggestDirs, setSuggestDirs] = useState<types.RemoteFile[]>([]);
  const [suggestSessionId, setSuggestSessionId] = useState(activeSessionId);
  const [suggestBusy, setSuggestBusy] = useState(false);
  const [suggestBusySessionId, setSuggestBusySessionId] = useState(activeSessionId);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [panel, setPanel] = useState<"manager" | "explorer" | null>(null);
  const [filter, setFilter] = useState("");
  const [selectedPathState, setSelectedPathState] = useState({ sessionId: activeSessionId, value: "" });
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const modifiedFormatter = useMemo(() => new Intl.DateTimeFormat(lang, { month: "short", day: "2-digit" }), [lang]);
  const pathWrapRef = useRef<HTMLDivElement>(null);
  const suggestSeq = useRef(0);

  // Windowed rendering state for the file list. Only the rows intersecting the
  // viewport (plus OVERSCAN_ROWS on each side) are mounted; spacer divs above
  // and below preserve the natural scroll height.
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(480);
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT_FALLBACK);
  const scrollFrame = useRef(0);

  const onListScroll = useCallback(() => {
    if (scrollFrame.current) return;
    scrollFrame.current = window.requestAnimationFrame(() => {
      scrollFrame.current = 0;
      if (listEl) setScrollTop(listEl.scrollTop);
    });
  }, [listEl]);

  useEffect(() => () => {
    if (scrollFrame.current) window.cancelAnimationFrame(scrollFrame.current);
  }, []);

  useEffect(() => {
    if (!listEl) return;
    const measure = () => setViewportH(listEl.clientHeight || 480);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(listEl);
    return () => observer.disconnect();
  }, [listEl]);

  // Rows are fixed-height by CSS; measure the first mounted one so the spacer
  // math tracks the real value instead of hardcoding it.
  useEffect(() => {
    if (!listEl) return;
    const row = listEl.querySelector<HTMLElement>(".sftp-file-row");
    if (!row) return;
    const height = row.getBoundingClientRect().height;
    if (height > 0) setRowHeight((prev) => (Math.abs(prev - height) < 0.5 ? prev : height));
  }, [listEl, files]);

  const draftPath = draftPathState.sessionId === activeSessionId ? draftPathState.value : path;
  const selectedPath = selectedPathState.sessionId === activeSessionId ? selectedPathState.value : "";
  const visibleSuggestDirs = suggestSessionId === activeSessionId ? suggestDirs : [];
  const visibleSuggestBusy = suggestBusySessionId === activeSessionId && suggestBusy;
  const setDraftPath = (value: string) => setDraftPathState({ sessionId: activeSessionId, value });
  const setSelectedPath = (value: string) => setSelectedPathState({ sessionId: activeSessionId, value });

  useEffect(() => setDraftPath(path), [activeSessionId, path]);

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
    const seq = ++suggestSeq.current;
    if (!pathFocus || !active || active.type === "markdown") return;
    const base = suggestBase || ".";
    // Current listing is enough when suggesting under the open folder.
    if (base === path || base === path.replace(/\/$/, "") || (base === "." && (path === "." || path === ""))) {
      setSuggestSessionId(active.id);
      setSuggestDirs(files.filter((f) => f.isDir));
      setSuggestBusySessionId(active.id);
      setSuggestBusy(false);
      return;
    }
    setSuggestBusySessionId(active.id);
    setSuggestBusy(true);
    ListRemoteDir(active.id, base)
      .then((list) => {
        if (seq !== suggestSeq.current) return;
        setSuggestSessionId(active.id);
        setSuggestDirs((list || []).filter((f) => f.isDir));
      })
      .catch(() => {
        if (seq !== suggestSeq.current) return;
        setSuggestSessionId(active.id);
        setSuggestDirs([]);
      })
      .finally(() => {
        if (seq === suggestSeq.current) setSuggestBusy(false);
      });
  }, [pathFocus, suggestBase, active?.id, active?.type, path, files]);

  const suggestions = useMemo(() => {
    const out: PathSuggest[] = [];
    const q = suggestPrefix.toLowerCase();
    const dirs = visibleSuggestDirs
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
  }, [visibleSuggestDirs, suggestPrefix, draftPath, path]);

  const breadcrumbs = useMemo(() => pathSegments(path), [path]);

  const visibleFiles = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = [...files].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      let result = 0;
      if (sortKey === "size") result = a.size - b.size;
      else if (sortKey === "modified") result = modifiedTime(a.modTime) - modifiedTime(b.modTime);
      else result = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      if (result === 0) result = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      return sortAsc ? result : -result;
    });
    if (!q) return list;
    return list.filter((f) => f.name.toLowerCase().includes(q));
  }, [files, filter, sortKey, sortAsc]);

  useEffect(() => {
    if (selectedPath && !files.some((file) => file.path === selectedPath)) setSelectedPath("");
  }, [files, selectedPath]);

  const goTo = useCallback(
    (next: string) => {
      setDraftPath(next);
      setSelectedPath("");
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

  const openEntry = (file: types.RemoteFile) => {
    if (file.isDir) goTo(file.path);
    else if (isSupportedTextPath(file.name)) props.onOpenMarkdownFile?.(active?.id || "", file.path);
    else download(file);
  };

  const fileMenuItems = (file: types.RemoteFile) => {
    const isTextFile = !file.isDir && isSupportedTextPath(file.name);
    return [
      ...(file.isDir
        ? [
            { label: t(lang, "open"), action: () => goTo(file.path) },
            { label: t(lang, "downloadFolder"), action: () => downloadFolder(file) },
          ]
        : [
            ...(isTextFile
              ? [{ label: t(lang, "openTextFile"), action: () => props.onOpenMarkdownFile?.(active?.id || "", file.path) }]
              : []),
            { label: t(lang, "download"), action: () => download(file) },
          ]),
      {
        label: t(lang, "copyPath"),
        action: () => {
          navigator.clipboard?.writeText(file.path)
            .then(() => onNotify(t(lang, "copyToClipboard"), "success"))
            .catch(() => onNotify(t(lang, "copyFailed"), "error"));
        },
      },
      { label: t(lang, "renameFile"), action: () => setDialog({ type: "rename", file }) },
      { label: t(lang, "delete"), action: () => setDialog({ type: "delete", file }), danger: true },
    ];
  };

  const showFileMenu = (file: types.RemoteFile, x: number, y: number) => {
    const items = fileMenuItems(file);
    const menuWidth = 168;
    const menuHeight = items.length * 31 + 10;
    setSelectedPath(file.path);
    props.setCtxMenu?.({
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
      items,
    });
  };

  // Row actions routed through a ref so the callbacks handed to memo(FileRow)
  // are identity-stable across renders (scrolling updates state every frame);
  // the ref always points at the latest closures.
  const rowActionsRef = useRef<FileRowActions>();
  rowActionsRef.current = {
    select: (file) => setSelectedPath(file.path),
    open: openEntry,
    menu: showFileMenu,
    openDir: (file) => goTo(file.path),
    openText: (file) => props.onOpenMarkdownFile?.(activeSessionId, file.path),
    download,
  };
  const onRowSelect = useCallback((file: types.RemoteFile) => rowActionsRef.current?.select(file), []);
  const onRowOpen = useCallback((file: types.RemoteFile) => rowActionsRef.current?.open(file), []);
  const onRowMenu = useCallback((file: types.RemoteFile, x: number, y: number) => rowActionsRef.current?.menu(file, x, y), []);
  const onRowOpenDir = useCallback((file: types.RemoteFile) => rowActionsRef.current?.openDir(file), []);
  const onRowOpenText = useCallback((file: types.RemoteFile) => rowActionsRef.current?.openText(file), []);
  const onRowDownload = useCallback((file: types.RemoteFile) => rowActionsRef.current?.download(file), []);

  const changeSort = (next: SortKey) => {
    if (sortKey === next) setSortAsc((value) => !value);
    else {
      setSortKey(next);
      setSortAsc(true);
    }
  };

  const sortIndicator = (key: SortKey) => sortKey === key
    ? (sortAsc ? <ChevronUp size={9} /> : <ChevronDown size={9} />)
    : null;

  if (!active) return <div className="empty compact">{t(lang, "connectFirstSftp")}</div>;

  // Visible slice of the (sorted, filtered) listing. scrollTop is clamped so a
  // stale value from a longer previous listing cannot push the window past the
  // end after navigation or filtering.
  const totalRows = visibleFiles.length;
  const effScrollTop = Math.min(scrollTop, Math.max(0, totalRows * rowHeight - viewportH));
  const startRow = Math.max(0, Math.floor(effScrollTop / rowHeight) - OVERSCAN_ROWS);
  const endRow = Math.min(totalRows, Math.ceil((effScrollTop + viewportH) / rowHeight) + OVERSCAN_ROWS);
  const windowedFiles = visibleFiles.slice(startRow, endRow);
  const topPad = startRow * rowHeight;
  const bottomPad = Math.max(0, (totalRows - endRow) * rowHeight);

  return (
    <div className="sftp-panel">
      <header className="sftp-browser-header" ref={pathWrapRef}>
        <div className="sftp-browser-topline">
          <div className="sftp-browser-title">
            <span className="sftp-browser-icon"><FolderOpen size={14} /></span>
            <span>
              <strong>{lang === "zh-CN" ? "远程文件" : "Remote files"}</strong>
              <small>{active.title || (lang === "zh-CN" ? "当前连接" : "Current connection")}</small>
            </span>
          </div>
          <div className="sftp-quick-actions">
            <button onClick={upload} title={t(lang, "upload")}><Upload size={12} /></button>
            <button onClick={() => setDialog({ type: "mkdir" })} title={t(lang, "newFolder")}><FolderPlus size={12} /></button>
            <button className={clsx(activeCount > 0 && "active")} onClick={() => setPanel("manager")} title={t(lang, "transferManager")}>
              <ArrowUpDown size={12} />
              {activeCount > 0 && <span className="sftp-action-badge">{activeCount}</span>}
            </button>
            <button onClick={() => setPanel("explorer")} title={t(lang, "dualPaneTransfer")}><Columns2 size={12} /></button>
          </div>
        </div>

        <div className="sftp-path-input-row">
          <button className="sftp-location-btn" onClick={goUp} title={t(lang, "parentDir")} disabled={path === "/" }>
            <ArrowUp size={13} />
          </button>
          <button className="sftp-location-btn" onClick={() => goTo("/")} title={t(lang, "goHomeRoot")}>
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
                    {visibleSuggestBusy
                      ? t(lang, "loading")
                      : t(lang, "pathSuggestions", { path: suggestBase || path })}
                  </span>
                </div>
                {suggestions.length === 0 && !visibleSuggestBusy && (
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
          <button className="sftp-location-btn" onClick={() => goTo(draftPath.trim() || path)} title={t(lang, "refresh")} disabled={busy}>
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
        <div className="sftp-list-controls">
          <label className="sftp-search">
            <Search size={11} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t(lang, "filterFiles")} />
            {filter && <button type="button" onClick={() => setFilter("")} title={lang === "zh-CN" ? "清除筛选" : "Clear filter"}><X size={10} /></button>}
          </label>
          <span className="sftp-item-count">{visibleFiles.length}{filter ? ` / ${files.length}` : ""}</span>
        </div>
      </header>

      <div className="sftp-file-table">
        <div className="sftp-file-head">
          <button className="sftp-col-name" onClick={() => changeSort("name")}>{t(lang, "name")}{sortIndicator("name")}</button>
          <button className="sftp-col-size" onClick={() => changeSort("size")}>{t(lang, "fileSizeCol")}{sortIndicator("size")}</button>
          <button className="sftp-col-modified" onClick={() => changeSort("modified")}>{lang === "zh-CN" ? "修改" : "Modified"}{sortIndicator("modified")}</button>
          <span className="sftp-col-actions" />
        </div>
        <div className="sftp-file-body" ref={setListEl} onScroll={onListScroll}>
          {busy && <div className="sftp-list-state"><RefreshCw size={15} className="sftp-spin" />{t(lang, "loading")}</div>}
          {!busy && visibleFiles.length === 0 && (
            <div className="sftp-list-state"><FolderOpen size={18} />{filter ? t(lang, "noMatchingFiles") : t(lang, "emptyFolder")}</div>
          )}
          {!busy && topPad > 0 && <div style={{ height: topPad }} aria-hidden="true" />}
          {!busy &&
            windowedFiles.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                selected={selectedPath === file.path}
                lang={lang}
                formatter={modifiedFormatter}
                onSelect={onRowSelect}
                onOpen={onRowOpen}
                onMenu={onRowMenu}
                onOpenDir={onRowOpenDir}
                onOpenText={onRowOpenText}
                onDownload={onRowDownload}
              />
            ))}
          {!busy && bottomPad > 0 && <div style={{ height: bottomPad }} aria-hidden="true" />}
        </div>
      </div>

      <div className="sftp-footer">
        <span className="sftp-footer-status">
          {selectedPath
            ? selectedPath.split("/").pop()
            : (lang === "zh-CN" ? `${files.length} 个项目` : `${files.length} item${files.length === 1 ? "" : "s"}`)}
        </span>
        <button className="sftp-terminal-btn" onClick={openTerminalHere} title={t(lang, "openTerminalInDir")}>
          <Terminal size={12} />
          <span>{t(lang, "openTerminalInDir")}</span>
        </button>
      </div>

      {dialog?.type === "mkdir" && (
        <TextInputDialog
          title={t(lang, "newFolder")}
          label={t(lang, "folderName")}
          locale={lang}
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
          locale={lang}
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
