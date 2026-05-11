import { Search } from "lucide-react";
import type { GlobalSearchResult } from "../../types";
import { ModalShell } from "./ModalShell";

export function GlobalSearchModal({ query, onQuery, results, onClose }: { query: string; onQuery: (value: string) => void; results: GlobalSearchResult[]; onClose: () => void }) {
  return (
    <ModalShell onClose={onClose} compact>
      <div className="search-box">
        <Search size={17} className="text-muted" />
        <input autoFocus className="search-input" value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} placeholder="Search servers, commands, settings" />
        <kbd>Ctrl K</kbd>
      </div>
      <div className="search-results">
        {results.map((item, index) => (
          <button key={`${item.type}-${item.title}-${index}`} className="search-result" onClick={() => { item.action(); onClose(); }}>
            <span className="result-kind">{item.type}</span>
            <span className="min-w-0 flex-1"><span className="block truncate text-sm">{item.title}</span><span className="block truncate text-xs text-muted">{item.subtitle}</span></span>
          </button>
        ))}
        {!results.length && <div className="empty compact">Type to search.</div>}
      </div>
    </ModalShell>
  );
}

export function TerminalSearchModal({ query, onQuery, onNext, onClose }: { query: string; onQuery: (value: string) => void; onNext: () => void; onClose: () => void }) {
  return (
    <ModalShell onClose={onClose} compact>
      <div className="search-box">
        <Search size={17} className="text-muted" />
        <input autoFocus className="search-input" value={query} onChange={(e) => onQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onNext(); if (e.key === "Escape") onClose(); }} placeholder="Find in current terminal" />
        <kbd>Ctrl F</kbd>
      </div>
      <button className="btn-primary mt-3 w-full" onClick={onNext}>Find next</button>
    </ModalShell>
  );
}

