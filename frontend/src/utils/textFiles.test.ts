import { describe, expect, it } from 'vitest';
import {
  documentEditorMode,
  isJsonLinesPath,
  isJsonPath,
  isMarkdownPath,
  isPdfPath,
  isSupportedDocumentPath,
  isSupportedTextPath,
} from './textFiles';

describe('document path helpers', () => {
  it('opens common deployment files and source documents without admitting arbitrary binaries', () => {
    for (const path of ['Dockerfile', '/srv/Dockerfile.prod', '.env.production', 'Makefile', 'settings.JSONC', 'events.ndjson', 'main.py', 'index.html', 'worker.ts']) {
      expect(isSupportedTextPath(path), path).toBe(true);
    }
    for (const path of ['image.png', 'program.exe', 'report.docx', 'archive.zip', 'arbitrary-file']) {
      expect(isSupportedDocumentPath(path), path).toBe(false);
    }
    expect(documentEditorMode('settings.jsonc')).toBe('jsonc');
    expect(documentEditorMode('events.ndjson')).toBe('jsonl');
  });
  it('keeps PDFs separate from editable text documents', () => {
    expect(isPdfPath('C:\\Docs\\Manual.PDF')).toBe(true);
    expect(isSupportedDocumentPath('manual.pdf')).toBe(true);
    expect(isSupportedTextPath('manual.pdf')).toBe(false);
    expect(isMarkdownPath('manual.pdf')).toBe(false);
  });

  it('retains existing text and Markdown support', () => {
    expect(isSupportedDocumentPath('/tmp/notes.txt')).toBe(true);
    expect(isMarkdownPath('/tmp/README.md')).toBe(true);
  });

  it('selects structured editor modes case-insensitively', () => {
    expect(isJsonPath('/tmp/settings.JSON')).toBe(true);
    expect(isJsonLinesPath('events.JsOnL')).toBe(true);
    expect(documentEditorMode('/tmp/settings.JSON')).toBe('json');
    expect(documentEditorMode('events.JsOnL')).toBe('jsonl');
    expect(documentEditorMode('README.markdown')).toBe('markdown');
    expect(documentEditorMode('notes.txt')).toBe('plain');
  });
});
