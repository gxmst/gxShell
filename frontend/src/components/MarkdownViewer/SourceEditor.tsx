import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';
import { EditorState, Compartment, EditorSelection, type ChangeSpec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit, LanguageDescription } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { toClipboardText } from '../../utils/clipboard';
import { countWords } from '../../utils/wordCount';
import { MAX_SYNTAX_CHARS, type DocumentHeading, type DocumentPresentation } from '../../utils/documentPresentation';
import type { DocumentScrollPosition } from '../../utils/documentReadingState';
import { previewDecorations } from './previewDecorations';
import '../../styles/source-editor.css';

export interface EditorStats {
  line: number;
  column: number;
  chars: number;
  words: number;
  selected: number;
}

export interface SourceEditorHandle {
  focus: () => void;
  selectAll: () => void;
  /** 0..1 scroll position, for handing scroll continuity across mode switches. */
  scrollRatio: () => number;
  setScrollRatio: (ratio: number) => void;
  scrollPosition: () => DocumentScrollPosition | null;
  setScrollPosition: (position: DocumentScrollPosition) => void;
  /** Select and scroll to a document range, used by the find bar. */
  revealRange: (from: number, to: number) => void;
  toggleWrap: (marker: string) => void;
  setHeading: (level: number) => void;
  insertLink: () => void;
  insertText: (text: string) => void;
  undo: () => void;
  redo: () => void;
}

export type SourceEditorMode = 'plain' | 'markdown' | 'json' | 'jsonc' | 'jsonl';

const WORD_COUNT_DEBOUNCE_MS = 240;

interface SourceEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onStats?: (stats: EditorStats) => void;
  onScroll?: () => void;
  /** Handles a pasted or dropped image, returning the Markdown to insert. */
  onImage?: (file: File) => Promise<string | null>;
  fontSize: number;
  wrap: boolean;
  mode: SourceEditorMode;
  readOnly?: boolean;
  ariaLabel?: string;
  handleRef?: Ref<SourceEditorHandle>;
  sourcePath?: string;
  presentation?: DocumentPresentation;
  headings?: DocumentHeading[];
  lineHeight?: number;
  columnWidth?: string;
}

const NO_HEADINGS: DocumentHeading[] = [];

// Markdown syntax colors, bound to the app's theme variables so the editor
// tracks the active theme instead of shipping its own palette.
const highlightStyle = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '700' },
  { tag: tags.strong, color: 'var(--text)', fontWeight: '700' },
  { tag: tags.emphasis, color: 'var(--text)', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--muted)' },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: tags.monospace, color: 'var(--ok, var(--accent))' },
  { tag: tags.list, color: 'var(--accent)' },
  { tag: tags.contentSeparator, color: 'var(--muted)' },
  { tag: tags.processingInstruction, color: 'var(--muted)' },
  { tag: tags.propertyName, color: 'var(--code-title)' },
  { tag: tags.string, color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
  { tag: [tags.separator, tags.brace], color: 'var(--muted)' },
  { tag: tags.keyword, color: 'var(--code-keyword)' },
  { tag: tags.comment, color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--code-title)' },
  { tag: [tags.typeName, tags.className], color: 'var(--code-title)' },
  { tag: tags.operator, color: 'var(--code-operator, var(--accent))' },
  { tag: [tags.tagName, tags.attributeName], color: 'var(--code-keyword)' },
]);

function languageExtension(mode: SourceEditorMode) {
  switch (mode) {
    case 'markdown':
      return markdown({ base: markdownLanguage });
    case 'json':
    case 'jsonc':
    case 'jsonl':
      // JSON Lines has one JSON value per physical line. The JSON grammar
      // still provides correct token highlighting for every line; document
      // validation is handled separately so additional root values are not
      // reported as false errors by a whole-document JSON linter.
      return json();
    default:
      return [];
  }
}

function accessExtensions(readOnly: boolean, ariaLabel?: string) {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({
      'aria-readonly': String(readOnly),
      ...(readOnly ? { tabindex: '0' } : {}),
      ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
    }),
  ];
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--src-font-size, 14px)',
    backgroundColor: 'var(--document-bg, var(--bg))',
    color: 'var(--text)',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    lineHeight: 'var(--src-line-height, 1.6)',
    padding: '18px 0 40vh',
    caretColor: 'var(--accent)',
  },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    border: 'none',
    color: 'color-mix(in srgb, var(--muted) 60%, transparent)',
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--accent)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--accent) 5%, transparent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  // CodeMirror's base theme sets the focused selection with a deliberately
  // specific selector:
  //   &dark.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground
  // which resolves to #233 — near-black, and it swallows the text under it. A
  // plain `.cm-selectionBackground` here loses on specificity, so match that
  // full path to actually win. Both the focused and unfocused cases are listed.
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, & > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
    background: 'color-mix(in srgb, var(--accent) 30%, transparent)',
  },
  '::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 16%, transparent)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    outline: 'none',
  },
  '.cm-panels': { backgroundColor: 'var(--panel-raised)', color: 'var(--text)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--warn) 32%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--warn) 55%, transparent)' },
  // The search panel's controls. Styled from theme variables so they are
  // correct under the app's light themes (Light, Yuzu Study) as well — the
  // `dark: true` flag below would otherwise leave CodeMirror's hard-coded dark
  // gradients and tooltip backgrounds showing through on a light background.
  '.cm-button': {
    border: '1px solid var(--border)',
    borderRadius: '7px',
    backgroundImage: 'none',
    backgroundColor: 'color-mix(in srgb, var(--panel-raised) 88%, transparent)',
    color: 'var(--text)',
  },
  '.cm-button:active': {
    backgroundImage: 'none',
    backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)',
  },
  '.cm-textfield': {
    border: '1px solid var(--border)',
    borderRadius: '7px',
    backgroundColor: 'color-mix(in srgb, var(--terminal) 32%, var(--panel-raised))',
    color: 'var(--text)',
  },
  '.cm-tooltip': {
    border: '1px solid var(--border)',
    backgroundColor: 'var(--panel-raised)',
    color: 'var(--text)',
  },
  // Selection/cursor/gutter/panel colors are all overridden above, so this flag
  // only still governs .cm-specialChar. Kept true because the default palette
  // suits the dark themes the app ships by default.
}, { dark: true });

/** Wraps or unwraps each selected range in `marker` (e.g. ** for bold). */
function toggleWrapCommand(marker: string) {
  return (view: EditorView): boolean => {
    if (view.state.readOnly) return false;
    const changes = view.state.changeByRange((range) => {
      const doc = view.state.doc;
      const before = doc.sliceString(Math.max(0, range.from - marker.length), range.from);
      const after = doc.sliceString(range.to, Math.min(doc.length, range.to + marker.length));

      // Already wrapped: strip the markers and keep the same text selected.
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - marker.length, to: range.from, insert: '' },
            { from: range.to, to: range.to + marker.length, insert: '' },
          ] as ChangeSpec[],
          range: EditorSelection.range(range.from - marker.length, range.to - marker.length),
        };
      }

      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ] as ChangeSpec[],
        // Empty selection: drop the caret between the new markers so typing
        // lands inside them.
        range: range.empty
          ? EditorSelection.cursor(range.from + marker.length)
          : EditorSelection.range(range.from + marker.length, range.to + marker.length),
      };
    });
    view.dispatch(changes, { scrollIntoView: true, userEvent: 'input.format' });
    return true;
  };
}

/** Sets (or clears, when already at that level) the ATX heading level. */
function setHeadingCommand(level: number) {
  return (view: EditorView): boolean => {
    if (view.state.readOnly) return false;
    const changes = view.state.changeByRange((range) => {
      const line = view.state.doc.lineAt(range.head);
      const existing = /^(#{1,6})\s+/.exec(line.text);
      const target = '#'.repeat(level) + ' ';
      const replacement = existing && existing[1].length === level ? '' : target;
      const from = line.from;
      const to = line.from + (existing ? existing[0].length : 0);
      const delta = replacement.length - (to - from);
      return {
        changes: [{ from, to, insert: replacement }] as ChangeSpec[],
        range: EditorSelection.cursor(Math.max(line.from, range.head + delta)),
      };
    });
    view.dispatch(changes, { scrollIntoView: true, userEvent: 'input.format' });
    return true;
  };
}

/** Wraps the selection as a link, leaving the caret in the empty URL slot. */
function insertLinkCommand(view: EditorView): boolean {
  if (view.state.readOnly) return false;
  const range = view.state.selection.main;
  const label = view.state.doc.sliceString(range.from, range.to);
  const insert = `[${label}]()`;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    // Caret inside the parentheses, ready for the URL.
    selection: EditorSelection.cursor(range.from + insert.length - 1),
    scrollIntoView: true,
    userEvent: 'input.format',
  });
  return true;
}

function capturePosition(view: EditorView): DocumentScrollPosition {
  const scroll = view.scrollDOM;
  const bounds = scroll.getBoundingClientRect();
  const top = Math.max(0, bounds.top - view.documentTop);
  const block = view.lineBlockAtHeight(top);
  const anchor = view.posAtCoords({ x: bounds.left + Math.min(80, bounds.width / 2), y: bounds.top + 1 }, false) ?? block.from;
  const coords = view.coordsAtPos(anchor);
  const max = scroll.scrollHeight - scroll.clientHeight;
  return { kind: 'source', anchor, offset: coords ? coords.top - bounds.top : block.top - top, ratio: max > 0 ? Math.min(1, Math.max(0, scroll.scrollTop / max)) : 0, left: scroll.scrollLeft };
}

export function SourceEditor({
  value,
  onChange,
  onSave,
  onStats,
  onScroll,
  onImage,
  fontSize,
  wrap,
  mode,
  readOnly = false,
  ariaLabel,
  handleRef,
  sourcePath,
  presentation = 'plain',
  headings = NO_HEADINGS,
  lineHeight = 1.6,
  columnWidth = '100%',
}: SourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const emittedValueRef = useRef<string | null>(null);
  const wrapCompartment = useRef(new Compartment());
  const langCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const chromeCompartment = useRef(new Compartment());
  const previewCompartment = useRef(new Compartment());
  const restoreFrameRef = useRef(0);
  const syntaxEnabled = value.length <= MAX_SYNTAX_CHARS;

  // Latest callbacks, read through refs so the editor is built once and never
  // torn down just because a parent re-rendered.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const onScrollRef = useRef(onScroll);
  onScrollRef.current = onScroll;
  const onImageRef = useRef(onImage);
  onImageRef.current = onImage;

  // useLayoutEffect, not useEffect: useImperativeHandle below also runs at
  // layout time, so a passive effect here would publish the handle to the
  // parent before the view existed. The parent restores the pre-switch scroll
  // position the moment it receives the handle, and that call would have hit a
  // null view and been dropped.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let wordCount = onStatsRef.current ? countWords(value) : 0;
    let wordCountTimer = 0;

    const reportStats = (view: EditorView) => {
      const report = onStatsRef.current;
      if (!report) return;
      const state = view.state;
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      let selected = 0;
      for (const range of state.selection.ranges) selected += range.to - range.from;
      report({
        line: line.number,
        column: head - line.from + 1,
        chars: state.doc.length,
        words: wordCount,
        selected,
      });
    };

    const scheduleWordCount = (view: EditorView, text: string) => {
      window.clearTimeout(wordCountTimer);
      if (!onStatsRef.current) return;
      wordCountTimer = window.setTimeout(() => {
        if (viewRef.current !== view) return;
        wordCount = countWords(text);
        reportStats(view);
      }, WORD_COUNT_DEBOUNCE_MS);
    };

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          chromeCompartment.current.of(readOnly
            ? (presentation === 'prose' ? [] : lineNumbers())
            : [lineNumbers(), highlightActiveLine(), highlightActiveLineGutter()]),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          rectangularSelection(),
          crosshairCursor(),
          bracketMatching(),
          highlightSelectionMatches(),
          // indentUnit is what Tab inserts; tabSize is how an existing literal
          // tab renders. Both 2, matching the textarea this replaced — otherwise
          // tab-indented files would reflow on open.
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          syntaxHighlighting(highlightStyle),
          langCompartment.current.of(syntaxEnabled ? languageExtension(mode) : []),
          wrapCompartment.current.of(wrap ? EditorView.lineWrapping : []),
          readOnlyCompartment.current.of(accessExtensions(readOnly, ariaLabel)),
          previewCompartment.current.of(readOnly ? previewDecorations(presentation, headings, sourcePath?.toLowerCase().endsWith('.tsv') ? '\t' : ',') : []),
          editorTheme,
          // Ordering matters: these bindings must win over defaultKeymap.
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: (view) => { if (!view.state.readOnly) onSaveRef.current(); return true; } },
            { key: 'Mod-b', preventDefault: true, run: toggleWrapCommand('**') },
            { key: 'Mod-i', preventDefault: true, run: toggleWrapCommand('*') },
            { key: 'Mod-`', preventDefault: true, run: toggleWrapCommand('`') },
            { key: 'Mod-k', preventDefault: true, run: insertLinkCommand },
            ...[1, 2, 3, 4, 5, 6].map((level) => ({
              key: `Mod-${level}`,
              preventDefault: true,
              run: setHeadingCommand(level),
            })),
          ]),
          // markdownKeymap (Enter-continues-list, and the Backspace that undoes
          // a marker) is deliberately NOT bound here: markdown() already
          // installs it at Prec.high. Binding it again would also apply it in
          // plain-text mode, where the language compartment is empty — Enter
          // would try to continue list markup inside a .conf or .log file.
          keymap.of(searchKeymap),
          keymap.of(historyKeymap),
          // Tab indents instead of moving focus out of the editor.
          keymap.of([indentWithTab]),
          keymap.of(defaultKeymap),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const text = update.state.doc.toString();
              emittedValueRef.current = text;
              if (!update.state.readOnly) onChangeRef.current(text);
              scheduleWordCount(update.view, text);
            }
            if (update.docChanged || update.selectionSet) reportStats(update.view);
          }),
          EditorView.domEventHandlers({
            scroll: () => { onScrollRef.current?.(); },
            paste: (event, editorView) => {
              if (editorView.state.readOnly) return false;
              const image = Array.from(event.clipboardData?.files || []).find((file) => file.type.startsWith('image/'));
              const handler = onImageRef.current;
              if (!image || !handler) return false;
              event.preventDefault();
              void handler(image).then((snippet) => {
                if (!snippet || viewRef.current !== editorView || editorView.state.readOnly) return;
                const range = editorView.state.selection.main;
                editorView.dispatch({
                  changes: { from: range.from, to: range.to, insert: snippet },
                  selection: EditorSelection.cursor(range.from + snippet.length),
                  userEvent: 'input.paste',
                });
              });
              return true;
            },
            drop: (event, editorView) => {
              if (editorView.state.readOnly) return false;
              const image = Array.from(event.dataTransfer?.files || []).find((file) => file.type.startsWith('image/'));
              const handler = onImageRef.current;
              if (!image || !handler) return false;
              event.preventDefault();
              void handler(image).then((snippet) => {
                if (!snippet || viewRef.current !== editorView || editorView.state.readOnly) return;
                const pos = editorView.posAtCoords({ x: event.clientX, y: event.clientY }) ?? editorView.state.selection.main.from;
                editorView.dispatch({
                  changes: { from: pos, insert: snippet },
                  selection: EditorSelection.cursor(pos + snippet.length),
                  userEvent: 'input.drop',
                });
              });
              return true;
            },
          }),
          // Win32 paste targets need CRLF, and CodeMirror writes the document's
          // own LF separators to the clipboard. Same reason as utils/clipboard.
          EditorView.clipboardOutputFilter.of((text) => toClipboardText(text)),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    reportStats(view);

    return () => {
      window.clearTimeout(wordCountTimer);
      cancelAnimationFrame(restoreFrameRef.current);
      view.destroy();
      viewRef.current = null;
    };
    // Built once on mount. Value/wrap/language/font changes are reconciled by
    // the effects below rather than by recreating the editor, which would lose
    // the undo history and cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (reload, revert, save-normalization). Skipped when
  // the document already matches, which is the case for the user's own edits
  // arriving back through onChange — otherwise every keystroke would round-trip
  // and reset the selection.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (emittedValueRef.current === value) {
      emittedValueRef.current = null;
      return;
    }
    if (view.state.doc.length === value.length && view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: Math.min(view.state.selection.main.anchor, value.length) },
    });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.current.reconfigure(wrap ? EditorView.lineWrapping : []),
    });
  }, [wrap]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    let cancelled = false;
    view.dispatch({ effects: langCompartment.current.reconfigure(syntaxEnabled ? languageExtension(mode) : []) });
    if (mode === 'plain' && syntaxEnabled && sourcePath && ['code', 'config'].includes(presentation)) {
      void import('@codemirror/language-data').then(async ({ languages }) => {
        const filename = sourcePath.split(/[\\/]/).pop() || '';
        const alias = /^(?:dockerfile|containerfile)(?:\.|$)/i.test(filename) ? 'Dockerfile'
          : /^(?:\.env(?:\.|$)|\.bashrc$|\.zshrc$|\.profile$)/i.test(filename) ? 'Shell'
            : /\.(?:ini|cfg|service)$|^\.editorconfig$/i.test(filename) ? 'Properties files'
              : /^gnumakefile$|^justfile$/i.test(filename) ? 'Makefile' : '';
        const language = alias ? LanguageDescription.matchLanguageName(languages, alias)
          : LanguageDescription.matchFilename(languages, filename);
        if (!language || cancelled) return;
        const extension = await language.load();
        if (!cancelled && viewRef.current === view) view.dispatch({ effects: langCompartment.current.reconfigure(extension) });
      }).catch(() => { /* Source remains usable if a language chunk cannot load. */ });
    }
    return () => { cancelled = true; };
  }, [mode, presentation, sourcePath, syntaxEnabled]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: [
      chromeCompartment.current.reconfigure(readOnly
        ? (presentation === 'prose' ? [] : lineNumbers())
        : [lineNumbers(), highlightActiveLine(), highlightActiveLineGutter()]),
      previewCompartment.current.reconfigure(readOnly ? previewDecorations(presentation, headings, sourcePath?.toLowerCase().endsWith('.tsv') ? '\t' : ',') : []),
    ] });
  }, [readOnly, presentation, headings, sourcePath]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: readOnlyCompartment.current.reconfigure(accessExtensions(readOnly, ariaLabel)) });
    if (!readOnly) view.focus();
  }, [readOnly, ariaLabel]);

  useImperativeHandle(handleRef, (): SourceEditorHandle => ({
    focus: () => viewRef.current?.focus(),
    selectAll: () => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });
      view.focus();
    },
    scrollRatio: () => {
      const el = viewRef.current?.scrollDOM;
      if (!el) return 0;
      const max = el.scrollHeight - el.clientHeight;
      return max > 0 ? el.scrollTop / max : 0;
    },
    setScrollRatio: (ratio) => {
      const el = viewRef.current?.scrollDOM;
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = max > 0 ? ratio * max : 0;
    },
    scrollPosition: () => viewRef.current ? capturePosition(viewRef.current) : null,
    setScrollPosition: (position) => {
      const view = viewRef.current;
      if (!view) return;
      if (position.kind !== 'source') {
        view.scrollDOM.scrollTop = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight) * position.ratio;
        return;
      }
      const anchor = Math.min(view.state.doc.length, Math.max(0, position.anchor));
      view.dispatch({ effects: EditorView.scrollIntoView(anchor, { y: 'start', yMargin: Math.max(0, position.offset) }) });
      cancelAnimationFrame(restoreFrameRef.current);
      restoreFrameRef.current = requestAnimationFrame(() => {
        if (viewRef.current !== view) return;
        view.requestMeasure({
          key: restoreFrameRef,
          read: () => {
            const coords = view.coordsAtPos(anchor);
            return coords ? coords.top - view.scrollDOM.getBoundingClientRect().top - position.offset : 0;
          },
          write: (delta) => {
            view.scrollDOM.scrollTop += delta;
            view.scrollDOM.scrollLeft = position.left;
            restoreFrameRef.current = requestAnimationFrame(() => {
              if (viewRef.current === view) onScrollRef.current?.();
            });
          },
        });
      });
    },
    revealRange: (from, to) => {
      const view = viewRef.current;
      if (!view) return;
      const max = view.state.doc.length;
      const start = Math.min(from, max);
      const end = Math.min(to, max);
      view.dispatch({
        selection: EditorSelection.range(start, end),
        effects: EditorView.scrollIntoView(EditorSelection.range(start, end), { y: 'center' }),
      });
      // Find-bar navigation selects the match without stealing its input focus.
    },
    toggleWrap: (marker) => { const v = viewRef.current; if (v) { toggleWrapCommand(marker)(v); v.focus(); } },
    setHeading: (level) => { const v = viewRef.current; if (v) { setHeadingCommand(level)(v); v.focus(); } },
    insertLink: () => { const v = viewRef.current; if (v) { insertLinkCommand(v); v.focus(); } },
    insertText: (text) => {
      const view = viewRef.current;
      if (!view || view.state.readOnly) return;
      const range = view.state.selection.main;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: EditorSelection.cursor(range.from + text.length),
        userEvent: 'input',
      });
      view.focus();
    },
    undo: () => { const v = viewRef.current; if (v && !v.state.readOnly) { undo(v); v.focus(); } },
    redo: () => { const v = viewRef.current; if (v && !v.state.readOnly) { redo(v); v.focus(); } },
  }), []);

  return (
    <div
      ref={hostRef}
      className={'source-editor' + (readOnly ? ' source-editor-readonly' : '')}
      data-presentation={readOnly ? presentation : 'code'}
      style={{ '--src-font-size': fontSize + 'px', '--src-line-height': lineHeight, '--reading-column': columnWidth } as React.CSSProperties}
    />
  );
}

export default SourceEditor;
