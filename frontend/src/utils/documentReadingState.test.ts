import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../test/memoryStorage';
import {
  getDocumentAppearance,
  readDocumentPosition,
  resetDocumentAppearance,
  subscribeDocumentAppearance,
  updateDocumentAppearance,
  writeDocumentPosition,
  readDocumentAppearance,
  type DocumentScrollPosition,
} from './documentReadingState';

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

describe('shared document appearance', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    resetDocumentAppearance();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('patches only the named field, so a second viewer cannot undo the first', () => {
    // The bug this replaced: each viewer wrote the whole object back from its
    // own state, so setting the line height in one pane restored the other
    // pane's stale zoom.
    updateDocumentAppearance({ zoom: 1.5 });
    updateDocumentAppearance({ leading: 2.1 });

    expect(getDocumentAppearance()).toEqual({ zoom: 1.5, leading: 2.1, width: 'comfortable' });
    expect(JSON.parse(localStorage.getItem('gx:documentAppearance')!)).toEqual({
      zoom: 1.5,
      leading: 2.1,
      width: 'comfortable',
    });
  });

  it('tells every viewer about a change, so the panes agree', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeDocumentAppearance(first);
    subscribeDocumentAppearance(second);

    updateDocumentAppearance({ width: 'wide' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    unsubscribeFirst();
    updateDocumentAppearance({ width: 'full' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('says nothing when the patch changes nothing', () => {
    updateDocumentAppearance({ zoom: 1.5 });
    const listener = vi.fn();
    subscribeDocumentAppearance(listener);
    updateDocumentAppearance({ zoom: 1.5 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps the same object identity while the value is unchanged', () => {
    const before = getDocumentAppearance();
    expect(getDocumentAppearance()).toBe(before);
    updateDocumentAppearance({ zoom: before.zoom });
    expect(getDocumentAppearance()).toBe(before);
  });

  it('reads the stored value once, then serves it to every viewer', () => {
    localStorage.setItem('gx:documentAppearance', JSON.stringify({ zoom: 1.8, leading: 1.5, width: 'wide' }));
    expect(getDocumentAppearance()).toEqual({ zoom: 1.8, leading: 1.5, width: 'wide' });
  });

  it('follows a value written to storage behind its back', () => {
    // The cached object is what keeps the snapshot stable for
    // useSyncExternalStore, but it is a memo of storage, not a second source of
    // truth - a stale cache silently disagreed with the stored value.
    expect(getDocumentAppearance().zoom).toBe(1);
    localStorage.setItem('gx:documentAppearance', JSON.stringify({ zoom: 1.6, leading: 1.5, width: 'wide' }));
    expect(getDocumentAppearance()).toEqual({ zoom: 1.6, leading: 1.5, width: 'wide' });
  });
});
