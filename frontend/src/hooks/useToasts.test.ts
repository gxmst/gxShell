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
});
