import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import { readDocumentPosition, writeDocumentPosition, readDocumentAppearance, type DocumentScrollPosition } from './documentReadingState';

const position: DocumentScrollPosition = { kind: 'source', anchor: 500, offset: -2, ratio: 0.25, left: 0 };

describe('document reading preferences', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('keeps file and remote-host positions separate and bounds stored history', () => {
    writeDocumentPosition('host-a:/notes.txt', position);
    writeDocumentPosition('host-b:/notes.txt', { ...position, anchor: 800 });
    expect(readDocumentPosition('host-a:/notes.txt')?.anchor).toBe(500);
    expect(readDocumentPosition('host-b:/notes.txt')?.anchor).toBe(800);
    for (let index = 0; index < 100; index++) writeDocumentPosition('local:' + index, position);
    expect(JSON.parse(localStorage.getItem('gx:documentReadingPositions')!)).toHaveLength(80);
    expect(readDocumentPosition('host-a:/notes.txt')).toBeNull();
  });

  it('rejects damaged positions and clamps stored typography', () => {
    localStorage.setItem('gx:documentReadingPositions', JSON.stringify([['invalid', { ...position, anchor: 1.5 }]]));
    expect(readDocumentPosition('invalid')).toBeNull();
    localStorage.setItem('gx:documentAppearance', JSON.stringify({ zoom: 300, leading: -1, width: 'broken' }));
    expect(readDocumentAppearance()).toEqual({ zoom: 2.2, leading: 1.4, width: 'comfortable' });
    localStorage.setItem('gx:documentAppearance', 'null');
    expect(readDocumentAppearance().zoom).toBe(1);
  });
});
