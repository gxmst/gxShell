import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToasts } from './useToasts';

// The dismissal timeout inside useToasts. Tests advance past it rather than
// waiting, so this must stay in step with the hook.
const DISMISS_MS = 3600;

describe('useToasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a toast and dismisses it after the timeout', () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.notify('saved', 'success'));
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.toasts[0]).toMatchObject({ text: 'saved', tone: 'success' });

    act(() => {
      vi.advanceTimersByTime(DISMISS_MS);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('defaults the tone to info', () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.notify('plain'));
    expect(result.current.toasts[0].tone).toBe('info');
  });

  // Regression: ids were built as Date.now() * 10000 + counter, which exceeds
  // Number.MAX_SAFE_INTEGER. Float spacing at that magnitude is 4, so the
  // counter's low bits were rounded away and toasts raised in the same
  // millisecond could collide. Duplicate ids are duplicate React keys, which
  // left a toast node on screen after its state entry had expired.
  it('gives distinct ids to many toasts raised in the same millisecond', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      for (let i = 0; i < 8; i++) result.current.notify(`message ${i}`);
    });

    expect(result.current.toasts).toHaveLength(8);
    const ids = result.current.toasts.map((toast) => toast.id);
    expect(new Set(ids).size).toBe(8);
  });

  it('dismisses every toast from one millisecond, leaving nothing on screen', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      for (let i = 0; i < 8; i++) result.current.notify(`message ${i}`);
    });

    act(() => {
      vi.advanceTimersByTime(DISMISS_MS);
    });
    expect(result.current.toasts).toHaveLength(0);
  });

  it('collapses a duplicate while the first is still showing', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.notify('connection lost', 'error');
      result.current.notify('connection lost', 'error');
    });

    expect(result.current.toasts).toHaveLength(1);
  });

  it('does not extend the original expiry when a duplicate arrives', () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.notify('connection lost', 'error'));
    act(() => {
      vi.advanceTimersByTime(DISMISS_MS - 100);
    });
    // Arrives just before the first expires: it must be dropped, and must not
    // reset the clock. An auto-reconnect loop reporting the same failure would
    // otherwise pin a toast on screen indefinitely.
    act(() => result.current.notify('connection lost', 'error'));
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(result.current.toasts).toHaveLength(0);
  });

  it('treats the same text with a different tone as its own toast', () => {
    const { result } = renderHook(() => useToasts());

    act(() => {
      result.current.notify('done', 'info');
      result.current.notify('done', 'success');
    });

    expect(result.current.toasts).toHaveLength(2);
  });

  it('allows the same text again once the first has been dismissed', () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.notify('connection lost', 'error'));
    act(() => {
      vi.advanceTimersByTime(DISMISS_MS);
    });
    act(() => result.current.notify('connection lost', 'error'));

    expect(result.current.toasts).toHaveLength(1);
  });

  it('clears pending timers on unmount', () => {
    const { result, unmount } = renderHook(() => useToasts());

    act(() => result.current.notify('saved'));
    unmount();

    // A timer firing after unmount would call setToasts on a dead component.
    expect(() => vi.advanceTimersByTime(DISMISS_MS)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });

  // The badge has to mean "there is something to deal with". Recording a
  // successful connection is useful history, but counting it would make the
  // number almost always noise — and then the one time it is a failure it gets
  // dismissed along with the rest.
  it('counts only attention-worthy activity towards the badge', () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.recordActivity({ text: 'Connection ready', tone: 'success', category: 'connection', toast: false }));
    act(() => result.current.recordActivity({ text: 'Connecting', tone: 'info', category: 'connection', toast: false }));
    expect(result.current.activities).toHaveLength(2);
    expect(result.current.unreadActivityCount).toBe(0);

    act(() => result.current.recordActivity({ text: 'Connection failed', tone: 'error', category: 'connection', toast: false }));
    expect(result.current.unreadActivityCount).toBe(1);

    // An informational item can still opt in when it genuinely needs noticing.
    act(() => result.current.recordActivity({ text: 'Update available', tone: 'info', category: 'update', attention: true, toast: false }));
    expect(result.current.unreadActivityCount).toBe(2);
  });

  // A repeat must not resurrect a record the user already dealt with unless the
  // repeat itself warrants attention. The dedupe key includes the tone, so this
  // only ever compares like with like.
  it('re-raises a read record only when the repeat warrants attention', () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.recordActivity({ text: 'sync finished', tone: 'info', category: 'transfer', dedupeKey: 'sync', attention: true, toast: false }));
    const informational = result.current.activities[0].id;
    expect(result.current.unreadActivityCount).toBe(1);
    act(() => result.current.markActivityRead(informational));

    act(() => result.current.recordActivity({ text: 'sync finished', tone: 'info', category: 'transfer', dedupeKey: 'sync', toast: false }));
    expect(result.current.activities).toHaveLength(1);
    expect(result.current.activities[0]).toMatchObject({ occurrences: 2, unread: false });

    act(() => result.current.recordActivity({ text: 'link down', tone: 'error', category: 'connection', dedupeKey: 'link', toast: false }));
    const failure = result.current.activities[0].id;
    act(() => result.current.markActivityRead(failure));
    expect(result.current.unreadActivityCount).toBe(0);

    act(() => result.current.recordActivity({ text: 'link still down', tone: 'error', category: 'connection', dedupeKey: 'link', toast: false }));
    expect(result.current.activities[0]).toMatchObject({ text: 'link still down', occurrences: 2, unread: true });
  });

  it('keeps informational legacy notify calls transient while the object API records activity', () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.notify('legacy message', 'info'));
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.activities).toHaveLength(0);

    act(() => result.current.notify({
      text: 'connection lost',
      tone: 'error',
      category: 'connection',
      scope: 'session-1',
      scopeLabel: 'prod',
      toast: false,
    }));
    expect(result.current.toasts).toHaveLength(1);
    expect(result.current.activities[0]).toMatchObject({
      text: 'connection lost',
      severity: 'error',
      category: 'connection',
      unread: true,
      scopeLabel: 'prod',
    });
    expect(result.current.unreadActivityCount).toBe(1);
  });

  // Nearly every failure in the app is reported through a legacy string call.
  // A toast the user was not looking at has to stay recoverable, so the failing
  // tones are kept in the history — and coalesced, because a retry loop reports
  // the same failure over and over.
  it('records failing legacy notifications and coalesces repeats', () => {
    const { result } = renderHook(() => useToasts());

    act(() => result.current.notify('connection lost', 'error'));
    act(() => {
      vi.advanceTimersByTime(DISMISS_MS);
    });
    act(() => result.current.notify('connection lost', 'error'));
    act(() => result.current.notify('disk almost full', 'warning'));

    expect(result.current.activities).toHaveLength(2);
    expect(result.current.activities.map((item) => item.text)).toEqual(['disk almost full', 'connection lost']);
    expect(result.current.activities[1]).toMatchObject({ severity: 'error', occurrences: 2 });
    expect(result.current.unreadActivityCount).toBe(2);
  });

  it('coalesces activity records by dedupe key and keeps the history bounded', () => {
    const { result } = renderHook(() => useToasts({ maxActivities: 2 }));

    act(() => result.current.recordActivity({ text: 'link down', tone: 'error', category: 'connection', dedupeKey: 'link', toast: false }));
    act(() => result.current.recordActivity({ text: 'link still down', tone: 'error', category: 'connection', dedupeKey: 'link', toast: false }));
    expect(result.current.activities).toHaveLength(1);
    expect(result.current.activities[0]).toMatchObject({ text: 'link still down', occurrences: 2, unread: true });

    act(() => {
      result.current.recordActivity({ text: 'one', toast: false });
      result.current.recordActivity({ text: 'two', toast: false });
    });
    expect(result.current.activities).toHaveLength(2);
    expect(result.current.activities.map((item) => item.text)).toEqual(['two', 'one']);
  });

  it('supports read, remove and optional localStorage persistence', () => {
    const key = 'test:activity-history';
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (name: string) => values.get(name) ?? null,
      setItem: (name: string, value: string) => values.set(name, value),
      removeItem: (name: string) => values.delete(name),
    });
    const { result, unmount } = renderHook(() => useToasts({ activityStorageKey: key }));

    act(() => result.current.recordActivity({ text: 'saved', category: 'system', toast: false }));
    expect(JSON.parse(values.get(key) || '[]')).toHaveLength(1);
    const id = result.current.activities[0].id;
    act(() => result.current.markActivityRead(id));
    expect(result.current.unreadActivityCount).toBe(0);
    act(() => result.current.removeActivity(id));
    expect(result.current.activities).toHaveLength(0);
    unmount();

    const restored = renderHook(() => useToasts({ activityStorageKey: key }));
    expect(restored.result.current.activities).toHaveLength(0);
    restored.unmount();
    vi.unstubAllGlobals();
  });

  it('keeps action callbacks on both the toast and activity record', () => {
    const onClick = vi.fn();
    const { result } = renderHook(() => useToasts());

    act(() => result.current.notifyActivity({
      text: 'ready',
      actions: [{ id: 'retry', label: 'Retry', onClick }],
    }));
    expect(result.current.activities[0].actions?.[0].onClick).toBe(onClick);
    expect(result.current.toasts[0].actions?.[0].onClick).toBe(onClick);
  });
});
