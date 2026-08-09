import { describe, expect, it } from 'vitest';
import { isMarkdownPath, isPdfPath, isSupportedDocumentPath, isSupportedTextPath } from './textFiles';

describe('document path helpers', () => {
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
});
