import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LINE_HEIGHT,
  DEFAULT_FONT_SIZE,
  DEFAULT_SCROLLBACK_LINES,
  normalizeFontSize,
  normalizeLineHeight,
  normalizeScrollbackLines,
} from './terminalSettings';

describe('normalizeFontSize', () => {
  it.each([
    [9, 9],
    [30, 30],
    ['14', 14],
  ])('keeps valid values %#', (value, expected) => {
    expect(normalizeFontSize(value)).toBe(expected);
  });

  it.each([undefined, null, '', 8, 31, 12.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back for invalid value %#',
    (value) => {
      expect(normalizeFontSize(value)).toBe(DEFAULT_FONT_SIZE);
    },
  );
});

describe('normalizeLineHeight', () => {
  it.each([
    [1, 1],
    [1.75, 1.75],
    [2.5, 2.5],
    ['1.5', 1.5],
  ])('preserves a valid value %j', (value, expected) => {
    expect(normalizeLineHeight(value)).toBe(expected);
  });

  it.each([
    0,
    0.99,
    -1,
    2.51,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '',
    null,
    undefined,
  ])('uses the default for invalid value %j', (value) => {
    expect(normalizeLineHeight(value)).toBe(DEFAULT_LINE_HEIGHT);
  });
});

describe('normalizeScrollbackLines', () => {
  it.each([
    [500, 500],
    [12000, 12000],
    [200000, 200000],
    ['8000', 8000],
  ])('preserves a valid value %j', (value, expected) => {
    expect(normalizeScrollbackLines(value)).toBe(expected);
  });

  it.each([
    0,
    499,
    -1,
    200001,
    500.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '',
    null,
    undefined,
  ])('uses the default for invalid value %j', (value) => {
    expect(normalizeScrollbackLines(value)).toBe(DEFAULT_SCROLLBACK_LINES);
  });
});
