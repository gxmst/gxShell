import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { GlobalSearchResult } from "../../types";
import { t } from "../../i18n";
import { ModalShell } from "./ModalShell";

export function GlobalSearchModal({ query, onQuery, results, onClose, locale = "en" }: { query: string; onQuery: (value: string) => void; results: GlobalSearchResult[]; onClose: () => void; locale?: string }) {
  return (
    <ModalShell onClose={onClose} compact>
      <div className="search-box">
        <Search size={17} className="text-muted" />
        <input autoFocus className="search-input" value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} placeholder={t(locale, "searchPlaceholder")} />
        <kbd>Ctrl K</kbd>
      </div>
      <div className="search-results">
        {results.map((item, index) => (
          <button key={`${item.type}-${item.title}-${index}`} className="search-result" onClick={() => { item.action(); onClose(); }}>
            <span className="result-kind">{item.type}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm">{item.title}</span><span className="block truncate text-xs text-muted">{item.subtitle}</span></span>
          </button>
        ))}
        {!results.length && <div className="empty compact">{t(locale, "typeToSearch")}</div>}
      </div>
    </ModalShell>
  );
}

export function TerminalSearchModal({ query, onQuery, onNext, onPrev, onClose, matchIndex, matchCount, locale = "en" }: { query: string; onQuery: (value: string) => void; onNext: () => void; onPrev: () => void; onClose: () => void; matchIndex?: number; matchCount?: number; locale?: string }) {
  // resultIndex from xterm is 0-based (-1 when no active match); show 1-based.
  const hasCount = typeof matchCount === "number" && query.length > 0;
  const countLabel = hasCount
    ? (matchCount === 0 ? "0/0" : `${(matchIndex ?? -1) >= 0 ? (matchIndex as number) + 1 : "-"}/${matchCount}`)
    : "";
  return (
    <ModalShell onClose={onClose} compact>
      <div className="search-box">
        <Search size={17} className="text-muted" />
        <input
          autoFocus
          className="search-input"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); if (e.shiftKey) onPrev(); else onNext(); }
            if (e.key === "Escape") onClose();
          }}
          placeholder={t(locale, "findInCurrentTerminal")}
        />
        {hasCount && <span className="text-[11px] text-muted tabular-nums min-w-[42px] text-right">{countLabel}</span>}
        <button className="icon-btn compact-icon" title={t(locale, "findPrev")} onClick={onPrev} disabled={!query}><ChevronUp size={14} /></button>
        <button className="icon-btn compact-icon" title={t(locale, "findNext")} onClick={onNext} disabled={!query}><ChevronDown size={14} /></button>
        <button className="icon-btn compact-icon" title={t(locale, "close")} onClick={onClose}><X size={14} /></button>
      </div>
    </ModalShell>
  );
}
