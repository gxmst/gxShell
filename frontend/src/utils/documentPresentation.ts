import { extensionOf, isMarkdownPath, isPdfPath } from './textFiles';

export type DocumentPresentation = 'markdown' | 'prose' | 'plain' | 'log' | 'code' | 'config' | 'data' | 'table' | 'pdf';

export interface DocumentHeading {
  id: string;
  text: string;
  depth: number;
  from?: number;
}

export interface DocumentOutline {
  items: DocumentHeading[];
  activeId: string;
  navigate: (id: string) => void;
  truncated?: boolean;
}

// File I/O has a byte limit in Go. These independent rendering budgets keep
// Markdown DOM construction and syntax parsing bounded even for valid files.
export const MAX_RICH_MARKDOWN_CHARS = 1024 * 1024;
export const MAX_RICH_MARKDOWN_LINES = 12000;
export const MAX_SYNTAX_CHARS = 1024 * 1024;
export const MAX_DOCUMENT_HEADINGS = 2000;

const configExtensions = new Set(['.conf', '.cfg', '.ini', '.env', '.yaml', '.yml', '.toml', '.xml', '.service']);
const dataExtensions = new Set(['.json', '.jsonc', '.jsonl', '.ndjson']);
const proseHeading = /^(?:第[零〇一二三四五六七八九十百千万两\d]+[章节卷部篇](?:\s|[：:、.．]|$).{0,90}|(?:chapter|part|section|appendix)\s+(?:\d+|[ivxlcdm]+|[a-z])(?:\s|[.:：-]|$).{0,90})$/i;
const logLine = /^(?:\[?\d{4}[-/]\d{2}[-/]\d{2}[T\s]|\[?\d{2}:\d{2}:\d{2}|\[?(?:TRACE|DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|CRITICAL)\b)/i;
const codeLine = /^(?:(?:import|export|const|let|var|function|class|def|package|func|SELECT|INSERT|CREATE|FROM)\s|[{}[\]<>]|[#;]|[\w.-]+\s*[=:]\s*\S)/;
const numberedHeading = /^(?:[一二三四五六七八九十百]{1,6}[、.．]\s*\S.{0,90}|\d{1,3}(?:\.\d{1,3}){0,3}[.)]?\s+[^\d\s].{0,90})$/;
const isProseHeading = (line: string) => proseHeading.test(line) || numberedHeading.test(line);

function proseSample(text: string) {
  // Sample the beginning, middle and end so a prose preamble cannot disguise
  // a log or configuration dump. Prefer complete lines, but keep bounded
  // fragments when a single paragraph is longer than the sample window.
  const size = 8192;
  if (text.length <= size * 3) return text;
  const sample = (start: number) => {
    const end = Math.min(text.length, start + size);
    const chunk = text.slice(start, end);
    const first = chunk.indexOf('\n');
    const last = chunk.lastIndexOf('\n');
    const from = start > 0 && first >= 0 ? first + 1 : 0;
    const to = end < text.length && last >= 0 ? last : chunk.length;
    return to > from ? chunk.slice(from, to) : chunk;
  };
  return [sample(0), sample(Math.floor(text.length / 2)), sample(text.length - size)].join('\n');
}

export function documentPresentation(path: string, text: string): DocumentPresentation {
  if (isMarkdownPath(path)) return 'markdown';
  if (isPdfPath(path)) return 'pdf';
  const ext = extensionOf(path);
  const name = (path.split(/[\\/]/).pop() || '').toLowerCase();
  if (ext === '.log') return 'log';
  if (dataExtensions.has(ext)) return 'data';
  if (ext === '.csv' || ext === '.tsv') return 'table';
  if (configExtensions.has(ext) || /^\.env(?:\.|$)/.test(name) || ['.gitignore', '.gitattributes', '.dockerignore', '.editorconfig'].includes(name)) return 'config';
  if (ext !== '.txt' && ext !== '.text') return 'code';

  const lines = proseSample(text).split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return 'plain';
  if (lines.filter((line) => logLine.test(line)).length >= Math.min(2, lines.length)) return 'log';
  // Be conservative: indentation, aligned columns and structured records are
  // meaningful text. Never remove whitespace or infer prose from the suffix.
  if (lines.some((line) => line.includes('\t') || /\S {3,}\S/.test(line) || codeLine.test(line) || /\u001b/.test(line))) return 'plain';
  const body = lines.filter((line) => !isProseHeading(line));
  const sentences = body.filter((line) => line.length >= 28 && /[。！？；]|[.!?](?:[”’"')）]|$|\s)/.test(line));
  const bodyChars = body.reduce((total, line) => total + line.length, 0);
  const sentenceChars = sentences.reduce((total, line) => total + line.length, 0);
  return bodyChars >= 80 && sentenceChars >= bodyChars * 0.7 ? 'prose' : 'plain';
}

export function needsLightweightMarkdown(text: string) {
  if (text.length > MAX_RICH_MARKDOWN_CHARS) return true;
  let lines = 0;
  let from = 0;
  while ((from = text.indexOf('\n', from)) >= 0) {
    if (++lines >= MAX_RICH_MARKDOWN_LINES) return true;
    from += 1;
  }
  return false;
}

export function textDocumentHeadings(text: string, markdown = false): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  let from = 0;
  let fence = '';
  while (from < text.length && headings.length < MAX_DOCUMENT_HEADINGS) {
    const end = text.indexOf('\n', from);
    const to = end < 0 ? text.length : end;
    if (to - from <= 160) {
      const line = text.slice(from, to).trim();
      const marker = markdown ? /^(\x60{3,}|~{3,})/.exec(line)?.[1] : undefined;
      if (marker) {
        if (!fence) fence = marker;
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = '';
      } else if (!fence) {
        const heading = markdown ? /^(#{1,6})\s+(.+?)(?:\s+#+)?$/.exec(line) : null;
        if (heading || (!markdown && isProseHeading(line))) {
          headings.push({ id: 'text-heading-' + from, text: heading ? heading[2] : line, depth: heading ? heading[1].length : 1, from });
        }
      }
    }
    from = to + 1;
  }
  return headings;
}
