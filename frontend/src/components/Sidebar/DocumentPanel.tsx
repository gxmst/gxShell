import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, FolderOpen, LocateFixed, Plus, RefreshCw, Search, X } from "lucide-react";
import clsx from "clsx";
import type { RecentMarkdownItem, Tab } from "../../types";
import { t } from "../../i18n";
import { isWindowsPlatform } from "../../utils/clipboard";
import { documentDirectory, extensionOf } from "../../utils/textFiles";

const fileName = (path: string) => path.split(/[\\/]/).pop() || path;
const PAGE_SIZE = 200;
const fileKind = (path: string) => /^\.env(?:\.|$)/i.test(fileName(path)) ? "ENV"
  : /^(?:dockerfile|containerfile)(?:\.|$)/i.test(fileName(path)) ? "DOCKER"
    : extensionOf(path).slice(1).toUpperCase() || "TEXT";
function pathKey(path: string, remote: boolean) {
  if (remote) return path;
  const value = path.replace(/\\/g, "/");
  return isWindowsPlatform() ? value.toLowerCase() : value;
}

export function DocumentPanel({ active, siblings, busy, error, recent, collapsed, language, host, onOpen, onPick, onRefresh, onOpenRecent, onRemoveRecent }: {
  active?: Tab; siblings: string[]; busy?: boolean; error?: string;
  recent: RecentMarkdownItem[]; collapsed: boolean; language: string; host?: string;
  onOpen?: (path: string) => void; onPick?: () => void; onRefresh?: () => void;
  onOpenRecent?: (item: RecentMarkdownItem) => void; onRemoveRecent?: (id: string) => void;
}) {
  const remote = active?.markdownSource === "remote";
  const path = active?.type === "markdown" ? (remote ? active.remotePath : active.filePath) || "" : "";
  const folder = path ? documentDirectory(path) : "";
  const folderKey = JSON.stringify([remote ? active?.remoteSessionId : "local", pathKey(folder, remote)]);
  const [filter, setFilter] = useState({ folder: folderKey, query: "" });
  const query = filter.folder === folderKey ? filter.query : "";
  const [recentOpen, setRecentOpen] = useState(false);
  const [reveal, setReveal] = useState(0);
  const activeRow = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pagination, setPagination] = useState({ key: "", page: 0 });
  const locale = language === "zh-CN" ? "zh-CN" : "en";
  const allFiles = useMemo(() => {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    return siblings.slice().sort((left, right) => collator.compare(fileName(left), fileName(right)));
  }, [siblings, locale]);
  const files = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    return allFiles.filter((file) => fileName(file).toLocaleLowerCase(locale).includes(needle));
  }, [allFiles, query, locale]);
  const pageKey = JSON.stringify([folderKey, query, path]);
  const currentIndex = files.findIndex((file) => pathKey(file, remote) === pathKey(path, remote));
  const defaultPage = Math.floor(Math.max(0, currentIndex) / PAGE_SIZE);
  const pageCount = Math.max(1, Math.ceil(files.length / PAGE_SIZE));
  const page = Math.min(pageCount - 1, pagination.key === pageKey ? pagination.page : defaultPage);
  const visibleFiles = files.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const revealCurrent = () => {
    const index = allFiles.findIndex((file) => pathKey(file, remote) === pathKey(path, remote));
    setFilter({ folder: folderKey, query: "" });
    setPagination({ key: JSON.stringify([folderKey, "", path]), page: Math.floor(Math.max(0, index) / PAGE_SIZE) });
    setReveal((value) => value + 1);
  };

  useLayoutEffect(() => {
    if (collapsed) return;
    const frame = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = 0;
      activeRow.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [path, collapsed, siblings, query, reveal, page]);

  return <div className="document-panel">
    <div className="panel-head document-panel-head">
      <span className="panel-head-title">{t(language, "documentsNav")}</span>
      <span className="panel-head-spacer" />
      <button className="icon-btn" disabled={!path} title={t(language, "revealCurrentDocument")} aria-label={t(language, "revealCurrentDocument")} onClick={revealCurrent}><LocateFixed size={14} /></button>
      <button className="icon-btn" disabled={!path || busy} title={t(language, "refreshDocumentFolder")} aria-label={t(language, "refreshDocumentFolder")} onClick={onRefresh}><RefreshCw size={14} className={busy ? "animate-spin" : undefined} /></button>
      <button className="btn-primary panel-head-primary" onClick={onPick} title={t(language, "openDocument")}><Plus size={13} />{t(language, "open")}</button>
    </div>
    {path ? <>
      <div className="document-folder" title={folder}>
        <FolderOpen size={17} />
        <div><strong>{fileName(folder)}</strong><small>{folder}</small></div>
        <span className="document-source" title={remote ? host : undefined}>{t(language, remote ? "remote" : "local")}</span>
      </div>
      {remote && host && <div className="document-host" title={host}>{host}</div>}
      <label className="document-filter"><Search size={13} /><input value={query} onChange={(event) => setFilter({ folder: folderKey, query: event.target.value })} aria-label={t(language, "filterDocumentFiles")} placeholder={t(language, "filterDocumentFiles")} />{query && <button type="button" onClick={() => setFilter({ folder: folderKey, query: "" })} aria-label={t(language, "clearDocumentFilter")}><X size={12} /></button>}</label>
      <section className="document-files text-file-section-current" aria-label={t(language, "siblingDocuments")} aria-busy={!!busy}>
        <div className="document-section-title"><span>{t(language, "siblingDocuments")}</span><span>{files.length}{query ? ` / ${siblings.length}` : ""}</span></div>
        <div className="text-file-list text-file-list-scroll" ref={listRef}>
          {visibleFiles.map((file) => {
            const current = pathKey(file, remote) === pathKey(path, remote);
            return <button key={file} ref={current ? activeRow : undefined} className={clsx("text-file-row", current && "active")} aria-current={current ? "page" : undefined} title={file} onClick={() => onOpen?.(file)}>
              <FileText size={14} /><span>{fileName(file)}</span><small className="document-kind">{fileKind(file)}</small>
            </button>;
          })}
          {error && <div className="document-folder-error" role="alert"><strong>{t(language, "documentFolderError")}</strong><span>{error}</span><button className="btn-secondary" onClick={onRefresh}>{t(language, "refreshDocumentFolder")}</button></div>}
          {!files.length && !error && <div className="document-empty" role="status">{t(language, busy ? "documentFolderLoading" : query ? "documentFilterEmpty" : "documentFolderEmpty")}</div>}
        </div>
        {pageCount > 1 && <div className="document-pagination">
          <span role="status">{t(language, "documentPageRange", { from: String(page * PAGE_SIZE + 1), to: String(Math.min(files.length, (page + 1) * PAGE_SIZE)), total: String(files.length) })}</span>
          <button className="icon-btn" disabled={page === 0} aria-label={t(language, "documentPreviousPage")} title={t(language, "documentPreviousPage")} onClick={() => setPagination({ key: pageKey, page: page - 1 })}><ChevronLeft size={14} /></button>
          <button className="icon-btn" disabled={page === pageCount - 1} aria-label={t(language, "documentNextPage")} title={t(language, "documentNextPage")} onClick={() => setPagination({ key: pageKey, page: page + 1 })}><ChevronRight size={14} /></button>
        </div>}
      </section>
    </> : <div className="document-empty document-start"><FolderOpen size={28} /><strong>{t(language, "documentNavigatorTitle")}</strong><span>{t(language, "documentNavigatorHint")}</span></div>}
    <section className={clsx("document-recents", (recentOpen || !path) && "document-recents-open")}>
      <button className="document-section-title document-recents-toggle" aria-expanded={recentOpen || !path} onClick={() => setRecentOpen((value) => !value)} disabled={!path}>
        <ChevronRight size={12} /><span>{t(language, "recentTextFiles")}</span><span>{recent.length}</span>
      </button>
      {(recentOpen || !path) && <div className="text-file-list text-file-list-scroll">
        {recent.map((item) => <div key={item.id} className="document-recent-row">
          <button className="document-recent-main" onClick={() => onOpenRecent?.(item)} title={item.path}><FileText size={13} /><span><strong>{item.title}</strong><small>{item.source === "remote" ? item.host || t(language, "remote") : t(language, "local")} · {item.path}</small></span></button>
          <button className="icon-btn" onClick={() => onRemoveRecent?.(item.id)} aria-label={`${t(language, "remove")} ${item.title}`} title={t(language, "remove")}><X size={12} /></button>
        </div>)}
        {!recent.length && <div className="document-empty">{t(language, "noRecentTextFiles")}</div>}
      </div>}
    </section>
  </div>;
}
