import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react';
import { EditorState, Compartment, EditorSelection, type ChangeSpec } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, highlightSpecialChars } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import { syntaxHighlighting, HighlightStyle, bracketMatching, indentUnit } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';
import { toClipboardText } from '../../utils/clipboard';
import { countWords } from '../../utils/wordCount';
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
  /** 0..1 scroll position, for handing scroll continuity across mode switches. */
  scrollRatio: () => number;
  setScrollRatio: (ratio: number) => void;
  /** Select and scroll to a document range, used by the find bar. */
  revealRange: (from: number, to: number) => void;
  toggleWrap: (marker: string) => void;
  setHeading: (level: number) => void;
  insertLink: () => void;
  insertText: (text: string) => void;
  undo: () => void;
  redo: () => void;
}

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
  markdownMode: boolean;
  handleRef?: Ref<SourceEditorHandle>;
}

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
]);

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--src-font-size, 14px)',
    backgroundColor: 'var(--bg)',
    color: 'var(--text)',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    lineHeight: '1.6',
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

export function SourceEditor({
  value,
  onChange,
  onSave,
  onStats,
  onScroll,
  onImage,
  fontSize,
  wrap,
  markdownMode,
  handleRef,
}: SourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const wrapCompartment = useRef(new Compartment());
  const langCompartment = useRef(new Compartment());

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
        words: countWords(state.doc.toString()),
        selected,
      });
    };

    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
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
          langCompartment.current.of(markdownMode ? markdown({ base: markdownLanguage }) : []),
          wrapCompartment.current.of(wrap ? EditorView.lineWrapping : []),
          editorTheme,
          // Ordering matters: these bindings must win over defaultKeymap.
          keymap.of([
            { key: 'Mod-s', preventDefault: true, run: () => { onSaveRef.current(); return true; } },
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
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) reportStats(update.view);
          }),
          EditorView.domEventHandlers({
            scroll: () => { onScrollRef.current?.(); },
            paste: (event, editorView) => {
              const image = Array.from(event.clipboardData?.files || []).find((file) => file.type.startsWith('image/'));
              const handler = onImageRef.current;
              if (!image || !handler) return false;
              event.preventDefault();
              void handler(image).then((snippet) => {
                if (!snippet) return;
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
              const image = Array.from(event.dataTransfer?.files || []).find((file) => file.type.startsWith('image/'));
              const handler = onImageRef.current;
              if (!image || !handler) return false;
              event.preventDefault();
              void handler(image).then((snippet) => {
                if (!snippet) return;
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
    view.focus();
    reportStats(view);

    return () => {
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
    if (!view || view.state.doc.toString() === value) return;
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
    viewRef.current?.dispatch({
      effects: langCompartment.current.reconfigure(markdownMode ? markdown({ base: markdownLanguage }) : []),
    });
  }, [markdownMode]);

  useImperativeHandle(handleRef, (): SourceEditorHandle => ({
    focus: () => viewRef.current?.focus(),
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
      view.focus();
    },
    toggleWrap: (marker) => { const v = viewRef.current; if (v) { toggleWrapCommand(marker)(v); v.focus(); } },
    setHeading: (level) => { const v = viewRef.current; if (v) { setHeadingCommand(level)(v); v.focus(); } },
    insertLink: () => { const v = viewRef.current; if (v) { insertLinkCommand(v); v.focus(); } },
    insertText: (text) => {
      const view = viewRef.current;
      if (!view) return;
      const range = view.state.selection.main;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: text },
        selection: EditorSelection.cursor(range.from + text.length),
        userEvent: 'input',
      });
      view.focus();
    },
    undo: () => { const v = viewRef.current; if (v) { undo(v); v.focus(); } },
    redo: () => { const v = viewRef.current; if (v) { redo(v); v.focus(); } },
  }), []);

  return (
    <div
      ref={hostRef}
      className="source-editor"
      style={{ '--src-font-size': `${fontSize}px` } as React.CSSProperties}
    />
  );
}

export default SourceEditor;
