import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import type { DocumentHeading, DocumentPresentation } from '../../utils/documentPresentation';

// Decorations are derived only for visible lines. They never replace document
// bytes, so selection, copying and search still use the original text.
export function previewDecorations(kind: DocumentPresentation, headings: DocumentHeading[], delimiter: string) {
  const headingOffsets = new Map(headings.map((heading) => [heading.from, heading.depth]));
  const build = (view: EditorView): DecorationSet => {
    const ranges = [];
    const visited = new Set<number>();
    for (const visible of view.visibleRanges) {
      let pos = visible.from;
      while (pos <= visible.to) {
        const line = view.state.doc.lineAt(pos);
        if (!visited.has(line.from)) {
          visited.add(line.from);
          const depth = headingOffsets.get(line.from);
          if (depth) ranges.push(Decoration.line({ class: 'document-prose-heading', attributes: { 'data-heading-depth': String(depth) } }).range(line.from));
          // Bound token scanning as well as DOM size for single-line dumps.
          const scanFrom = Math.max(line.from, visible.from);
          const scanTo = Math.min(line.to, visible.to, scanFrom + 16000);
          const text = view.state.sliceDoc(scanFrom, scanTo);
          if (kind === 'log') {
            const level = /\b(TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b/i.exec(text);
            if (level) {
              const name = /ERROR|FATAL|CRITICAL/i.test(level[0]) ? 'error' : /WARN/i.test(level[0]) ? 'warning' : 'info';
              ranges.push(Decoration.mark({ class: 'document-log-' + name }).range(scanFrom + level.index, scanFrom + level.index + level[0].length));
            }
          } else if (kind === 'table') {
            if (line.number === 1) ranges.push(Decoration.line({ class: 'document-table-header' }).range(line.from));
            for (let at = text.indexOf(delimiter); at >= 0; at = text.indexOf(delimiter, at + 1)) {
              ranges.push(Decoration.mark({ class: 'document-table-separator' }).range(scanFrom + at, scanFrom + at + 1));
            }
          }
        }
        if (line.to >= visible.to) break;
        pos = line.to + 1;
      }
    }
    return Decoration.set(ranges, true);
  };
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = build(view); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = build(update.view);
    }
  }, { decorations: (plugin) => plugin.decorations });
}
