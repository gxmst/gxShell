import { describe, expect, it } from 'vitest';
import { applyEol, detectEol, eolLabel, toLf } from './eol';

describe('detectEol', () => {
  it('detects a CRLF document', () => {
    expect(detectEol('a\r\nb\r\nc')).toBe('crlf');
  });

  it('detects an LF document', () => {
    expect(detectEol('a\nb\nc')).toBe('lf');
  });

  it('treats a mostly-CRLF document as CRLF', () => {
    expect(detectEol('a\r\nb\r\nc\nd')).toBe('crlf');
  });

  it('treats a mostly-LF document as LF', () => {
    expect(detectEol('a\nb\nc\nd\r\n')).toBe('lf');
  });

  it('falls back when the document has no newline at all', () => {
    expect(detectEol('single line', 'crlf')).toBe('crlf');
    expect(detectEol('', 'lf')).toBe('lf');
  });
});

describe('toLf', () => {
  it('normalizes CRLF and lone CR', () => {
    expect(toLf('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });
});

describe('applyEol', () => {
  it('restores CRLF without doubling existing carriage returns', () => {
    expect(applyEol('a\nb', 'crlf')).toBe('a\r\nb');
    expect(applyEol('a\r\nb', 'crlf')).toBe('a\r\nb');
  });

  it('leaves an LF document alone', () => {
    expect(applyEol('a\nb', 'lf')).toBe('a\nb');
  });

  it('round-trips a CRLF document through the editor form', () => {
    const original = 'line one\r\nline two\r\nline three\r\n';
    const eol = detectEol(original);
    expect(applyEol(toLf(original), eol)).toBe(original);
  });
});

describe('eolLabel', () => {
  it('labels both endings', () => {
    expect(eolLabel('crlf')).toBe('CRLF');
    expect(eolLabel('lf')).toBe('LF');
  });
});
