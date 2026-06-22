import { Search } from "lucide-react";
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

export function TerminalSearchModal({ query, onQuery, onNext, onClose, locale = "en" }: { query: string; onQuery: (value: string) => void; onNext: () => void; onClose: () => void; locale?: string }) {
  return (
    <ModalShell onClose={onClose} compact>
      <div className="search-box">
        <Search size={17} className="text-muted" />
        <input autoFocus className="search-input" value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onNext(); if (e.key === "Escape") onClose(); }} placeholder={t(locale, "findInCurrentTerminal")} />
        <kbd>Ctrl F</kbd>
      </div>
      <button className="btn-primary mt-3 w-full" onClick={onNext}>{t(locale, "findNext")}</button>
    </ModalShell>
  );
}
