import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  LayoutPanelLeft,
  Search,
  Server,
  TerminalSquare,
  X,
  Zap,
} from "lucide-react";
import type { GlobalSearchResult } from "../../types";
import { t } from "../../i18n";
import {
  parsePaletteQuery,
  rememberPaletteResult,
  searchPaletteResults,
  type PaletteResultLike,
} from "../../utils/paletteSearch";
import { ModalShell } from "./ModalShell";

export type CommandPaletteResult = GlobalSearchResult & Partial<Omit<PaletteResultLike, "type" | "title" | "action">>;

function resultIcon(type: string) {
  const key = (type || "").toLowerCase();
  if (key === "server" || key === "profile") return <Server size={14} />;
  if (key === "command" || key === "cmd") return <Zap size={14} />;
  if (key === "area" || key === "panel") return <LayoutPanelLeft size={14} />;
  if (key === "terminal" || key === "session") return <TerminalSquare size={14} />;
  return <Search size={14} />;
}

function resultTone(type: string): string {
  const key = (type || "").toLowerCase();
  if (key === "server" || key === "profile") return "server";
  if (key === "command" || key === "cmd") return "command";
  if (key === "area" || key === "panel") return "area";
  return "default";
}

function HighlightedText({ text, indices }: { text: string; indices: readonly number[] }) {
  if (!indices.length) return <>{text}</>;
  const highlighted = new Set(indices);
  return <>{Array.from(text).map((char, index) => highlighted.has(index)
    ? <mark key={index} className="cmdk-match">{char}</mark>
    : char)}</>;
}

export function GlobalSearchModal({
  query,
  onQuery,
  results,
  onClose,
  locale = "en",
}: {
  query: string;
  onQuery: (value: string) => void;
  results: CommandPaletteResult[];
  onClose: () => void;
  locale?: string;
}) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const parsedQuery = parsePaletteQuery(query);
  // The cap is applied after ranking, never before: slicing the candidate list
  // first would hide whatever the fuzzy matcher was supposed to surface.
  const matches = searchPaletteResults(results, query).slice(0, parsedQuery.query.trim() ? 24 : 18);

  // Reset highlight when the result set changes.
  useEffect(() => {
    setActive(0);
  }, [query, matches.length]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (index: number) => {
    const item = matches[index]?.result;
    if (!item) return;
    rememberPaletteResult(item);
    item.action();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (!matches.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(active);
    }
  };

  return (
    <ModalShell onClose={onClose} palette ariaLabel={t(locale, "search")}>
      <div className="cmdk" onKeyDown={onKeyDown}>
        <div className="cmdk-search">
          <Search size={18} className="cmdk-search-icon" />
          {parsedQuery.mode !== "all" && (
            <span className="cmdk-item-kind" aria-label={`Search mode: ${parsedQuery.mode}`}>
              {parsedQuery.mode === "commands" ? ">" : parsedQuery.mode === "sessions" ? "@" : "#"}
            </span>
          )}
          <input
            ref={inputRef}
            autoFocus
            className="cmdk-input"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={t(locale, "searchPlaceholder")}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="cmdk-search-meta">
            {query && (
              <button
                type="button"
                className="cmdk-clear"
                onClick={() => {
                  onQuery("");
                  inputRef.current?.focus();
                }}
                title={t(locale, "close")}
              >
                <X size={13} />
              </button>
            )}
            <kbd className="kbd">esc</kbd>
          </div>
        </div>

        <div className="cmdk-body" ref={listRef}>
          {matches.length > 0 ? (
            <div className="cmdk-list" role="listbox">
              {matches.map(({ result: item, highlights, group }, index) => (
                <button
                  key={`${item.type}-${item.title}-${index}`}
                  type="button"
                  role="option"
                  data-idx={index}
                  aria-selected={active === index}
                  className={clsx("cmdk-item", active === index && "cmdk-item-active")}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => run(index)}
                >
                  <span className={clsx("cmdk-item-icon", `cmdk-tone-${resultTone(item.type)}`)}>
                    {resultIcon(item.type)}
                  </span>
                  <span className="cmdk-item-text">
                    <span className="cmdk-item-title"><HighlightedText text={item.title} indices={highlights} /></span>
                    {item.subtitle && <span className="cmdk-item-sub">{item.subtitle}</span>}
                  </span>
                  <span className="cmdk-item-meta">
                    <span className="cmdk-item-kind" title={group}>{group}</span>
                    {item.defaultShortcuts?.[0] && (
                      <kbd className="cmdk-item-shortcut" title="Default shortcut">{item.defaultShortcuts[0]}</kbd>
                    )}
                  </span>
                  {active === index && (
                    <span className="cmdk-item-enter" aria-hidden>
                      <CornerDownLeft size={12} />
                    </span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="cmdk-empty">
              <div className="cmdk-empty-icon">
                <Search size={22} />
              </div>
              <div className="cmdk-empty-title">{t(locale, "typeToSearch")}</div>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

export function TerminalSearchModal({
  query,
  onQuery,
  onNext,
  onPrev,
  onClose,
  matchIndex,
  matchCount,
  locale = "en",
}: {
  query: string;
  onQuery: (value: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  matchIndex?: number;
  matchCount?: number;
  locale?: string;
}) {
  const hasCount = typeof matchCount === "number" && query.length > 0;
  const countLabel = hasCount
    ? matchCount === 0
      ? "0/0"
      : `${(matchIndex ?? -1) >= 0 ? (matchIndex as number) + 1 : "-"}/${matchCount}`
    : "";

  return (
    <ModalShell onClose={onClose} palette compact ariaLabel={t(locale, "findInCurrentTerminal")}>
      <div className="cmdk cmdk-find">
        <div className="cmdk-search">
          <Search size={16} className="cmdk-search-icon" />
          <input
            autoFocus
            className="cmdk-input"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) onPrev();
                else onNext();
              }
              if (e.key === "Escape") onClose();
            }}
            placeholder={t(locale, "findInCurrentTerminal")}
            spellCheck={false}
          />
          {hasCount && <span className="cmdk-find-count">{countLabel}</span>}
          <button className="cmdk-icon-btn" title={t(locale, "findPrev")} onClick={onPrev} disabled={!query}>
            <ChevronUp size={14} />
          </button>
          <button className="cmdk-icon-btn" title={t(locale, "findNext")} onClick={onNext} disabled={!query}>
            <ChevronDown size={14} />
          </button>
          <button className="cmdk-icon-btn" title={t(locale, "close")} onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
