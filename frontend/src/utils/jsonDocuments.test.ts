import { describe, expect, it } from 'vitest';
import { formatJsonDocument, validateJsonDocument } from './jsonDocuments';

describe('validateJsonDocument', () => {
  it('accepts every JSON root type', () => {
    for (const text of ['{"ok":true}', '[1,2]', '"text"', '42', 'false', 'null']) {
      expect(validateJsonDocument(text, 'json')).toEqual({ valid: true });
    }
  });

  it('returns a structured one-based position for invalid multiline JSON', () => {
    const result = validateJsonDocument('{\n  "ok": true,\n  "bad": }\n', 'json');
    expect(result).toEqual({
      valid: false,
      error: { code: 'syntax', offset: 25, line: 3, column: 10 },
    });
  });

  it('handles CRLF positions without counting the pair as two lines', () => {
    const result = validateJsonDocument('{\r\n  "bad": }\r\n', 'json');
    expect(result).toEqual({
      valid: false,
      error: { code: 'syntax', offset: 12, line: 2, column: 10 },
    });
  });

  it('validates JSON Lines independently and reports the first bad line', () => {
    expect(validateJsonDocument('{"a":1}\n\n[2,3]\ntrue', 'jsonl')).toEqual({ valid: true });
    expect(validateJsonDocument('{"a":1}\n{"b":}\n{"c":3}', 'jsonl')).toEqual({
      valid: false,
      error: { code: 'syntax', offset: 13, line: 2, column: 6 },
    });
  });

  it('treats an empty JSONL document as an empty sequence', () => {
    expect(validateJsonDocument('\n  \n', 'jsonl')).toEqual({ valid: true });
  });
});

describe('formatJsonDocument', () => {
  it('pretty-prints JSON without changing its value', () => {
    const result = formatJsonDocument('{"a":1,"nested":{"ok":true}}', 'json');
    expect(result).toEqual({
      ok: true,
      text: '{\n  "a": 1,\n  "nested": {\n    "ok": true\n  }\n}',
    });
  });

  it('preserves numeric tokens that JavaScript Number cannot round-trip', () => {
    expect(formatJsonDocument('{"big":9007199254740993,"overflow":1e400,"negativeZero":-0}', 'json')).toEqual({
      ok: true,
      text: '{\n  "big": 9007199254740993,\n  "overflow": 1e400,\n  "negativeZero": -0\n}',
    });
    expect(formatJsonDocument('{"big":9007199254740993}\n{"overflow":1e400,"negativeZero":-0}', 'jsonl')).toEqual({
      ok: true,
      text: '{"big":9007199254740993}\n{"overflow":1e400,"negativeZero":-0}',
    });
  });

  it('preserves CRLF and whether the document had a trailing line ending', () => {
    expect(formatJsonDocument('{"a":1}\r\n', 'json')).toEqual({
      ok: true,
      text: '{\r\n  "a": 1\r\n}\r\n',
    });
    expect(formatJsonDocument('{"a":1}', 'json')).toEqual({
      ok: true,
      text: '{\n  "a": 1\n}',
    });
  });

  it('compacts each JSONL value while preserving blank lines and line endings', () => {
    expect(formatJsonDocument('{ "a": 1 }\r\n\r\n[ 2, 3 ]\r\n', 'jsonl')).toEqual({
      ok: true,
      text: '{"a":1}\r\n\r\n[2,3]\r\n',
    });
  });

  it('returns the validation error without producing replacement text', () => {
    expect(formatJsonDocument('{"a":}', 'json')).toEqual({
      ok: false,
      error: { code: 'syntax', offset: 5, line: 1, column: 6 },
    });
  });
});
