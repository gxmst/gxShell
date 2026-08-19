import { jsonLanguage } from '@codemirror/lang-json';
import { applyEdits, createScanner, format } from 'jsonc-parser';

export type JsonDocumentMode = 'json' | 'jsonl';

export interface JsonDocumentError {
  code: 'syntax';
  /** Zero-based UTF-16 offset, matching CodeMirror document positions. */
  offset: number;
  /** One-based physical line number. */
  line: number;
  /** One-based UTF-16 column, matching the editor status bar. */
  column: number;
}

export type JsonValidationResult =
  | { valid: true }
  | { valid: false; error: JsonDocumentError };

export type JsonFormatResult =
  | { ok: true; text: string }
  | { ok: false; error: JsonDocumentError };

interface PhysicalLine {
  text: string;
  start: number;
  number: number;
}

function firstSyntaxErrorOffset(text: string): number | null {
  const tree = jsonLanguage.parser.parse(text);
  let first: number | null = null;
  tree.iterate({
    enter(node) {
      if (node.type.isError && (first === null || node.from < first)) first = node.from;
    },
  });
  return first;
}

function positionAt(text: string, offset: number): Pick<JsonDocumentError, 'line' | 'column'> {
  const target = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let column = 1;
  for (let index = 0; index < target; index += 1) {
    const char = text[index];
    if (char === '\r') {
      if (text[index + 1] === '\n' && index + 1 < target) index += 1;
      line += 1;
      column = 1;
    } else if (char === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function syntaxError(text: string, offset: number): JsonDocumentError {
  return { code: 'syntax', offset, ...positionAt(text, offset) };
}

function physicalLines(text: string): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\r' && char !== '\n') continue;
    lines.push({ text: text.slice(start, index), start, number });
    if (char === '\r' && text[index + 1] === '\n') index += 1;
    start = index + 1;
    number += 1;
  }
  lines.push({ text: text.slice(start), start, number });
  return lines;
}

function validateJson(text: string): JsonValidationResult {
  const offset = firstSyntaxErrorOffset(text);
  return offset === null ? { valid: true } : { valid: false, error: syntaxError(text, offset) };
}

function validateJsonLines(text: string): JsonValidationResult {
  for (const line of physicalLines(text)) {
    if (!line.text.trim()) continue;
    const localOffset = firstSyntaxErrorOffset(line.text);
    if (localOffset !== null) {
      return {
        valid: false,
        error: {
          code: 'syntax',
          offset: line.start + localOffset,
          line: line.number,
          column: localOffset + 1,
        },
      };
    }
  }
  return { valid: true };
}

export function validateJsonDocument(text: string, mode: JsonDocumentMode): JsonValidationResult {
  return mode === 'jsonl' ? validateJsonLines(text) : validateJson(text);
}

function detectedLineEnding(text: string): string {
  return text.match(/\r\n|\r|\n/)?.[0] ?? '\n';
}

function prettyPrintJson(text: string, ending: string): string {
  const edits = format(text, undefined, { insertSpaces: true, tabSize: 2, eol: ending });
  return applyEdits(text, edits).trim();
}

function compactJson(text: string): string {
  const scanner = createScanner(text, true);
  let output = '';
  while (scanner.getPosition() < text.length) {
    scanner.scan();
    const start = scanner.getTokenOffset();
    const length = scanner.getTokenLength();
    if (length > 0) output += text.slice(start, start + length);
  }
  return output;
}

export function formatJsonDocument(text: string, mode: JsonDocumentMode): JsonFormatResult {
  const validation = validateJsonDocument(text, mode);
  if (!validation.valid) return { ok: false, error: validation.error };

  if (mode === 'json') {
    const ending = detectedLineEnding(text);
    const hadTrailingEnding = /(?:\r\n|\r|\n)$/.test(text);
    // jsonc-parser's formatter edits whitespace only. Keeping the original
    // token slices avoids IEEE-754 coercion of large numbers, overflowed
    // exponents, and negative zero.
    const formatted = prettyPrintJson(text, ending);
    return { ok: true, text: formatted + (hadTrailingEnding ? ending : '') };
  }

  const ending = detectedLineEnding(text);
  const formatted = physicalLines(text).map((line) => (
    line.text.trim() ? compactJson(line.text) : ''
  ));
  return { ok: true, text: formatted.join(ending) };
}
