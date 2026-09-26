import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebglBudget, notifyWebglOnce, resetWebglNotices, MAX_WEBGL_CONTEXTS } from './terminalWebgl';

afterEach(() => resetWebglNotices());

describe('webgl context budget', () => {
  it('evicts nothing while there is room', () => {
    const budget = createWebglBudget(2);
    expect(budget.acquire('a')).toEqual([]);
    expect(budget.acquire('b')).toEqual([]);
    expect(budget.holders()).toEqual(['a', 'b']);
  });

  it('gives up the least recently used context, not a random one', () => {
    // The browser would otherwise pick the victim itself, and the context it
    // takes can belong to the terminal the user is looking at.
    const budget = createWebglBudget(2);
    budget.acquire('a');
    budget.acquire('b');
    expect(budget.acquire('c')).toEqual(['a']);
    expect(budget.holders()).toEqual(['b', 'c']);
  });

  it('counts a terminal that was looked at as recently used', () => {
    const budget = createWebglBudget(2);
    budget.acquire('a');
    budget.acquire('b');
    budget.touch('a');
    expect(budget.acquire('c')).toEqual(['b']);
    expect(budget.holders()).toEqual(['a', 'c']);
  });

  it('frees a slot when a terminal is closed', () => {
    const budget = createWebglBudget(2);
    budget.acquire('a');
    budget.acquire('b');
    budget.release('a');
    expect(budget.acquire('c')).toEqual([]);
    expect(budget.holders()).toEqual(['b', 'c']);
  });

  it('remembers an evicted terminal so it can ask for a context again', () => {
    const budget = createWebglBudget(1);
    budget.acquire('a');
    budget.acquire('b');
    expect(budget.wantsWebgl('a')).toBe(true);
    expect(budget.wantsWebgl('b')).toBe(false);

    // Getting a context back clears the request.
    budget.acquire('a');
    expect(budget.wantsWebgl('a')).toBe(false);
    expect(budget.holders()).toEqual(['a']);
  });

  it('lets a context lost to the browser be asked for again', () => {
    const budget = createWebglBudget(2);
    budget.acquire('a');
    budget.release('a');
    budget.want('a');
    expect(budget.wantsWebgl('a')).toBe(true);
    expect(budget.holders()).toEqual([]);
  });

  it('does not mark a terminal that still holds a context as wanting one', () => {
    const budget = createWebglBudget(2);
    budget.acquire('a');
    budget.want('a');
    expect(budget.wantsWebgl('a')).toBe(false);
  });

  it('forgets everything about a closed terminal', () => {
    const budget = createWebglBudget(1);
    budget.acquire('a');
    budget.acquire('b');
    expect(budget.wantsWebgl('a')).toBe(true);
    budget.forget('a');
    expect(budget.wantsWebgl('a')).toBe(false);
    expect(budget.holders()).toEqual(['b']);
  });

  it('leaves headroom under the browser limit', () => {
    // Chromium keeps about sixteen; staying below it is the whole point.
    expect(MAX_WEBGL_CONTEXTS).toBeLessThan(16);
  });
});

describe('webgl notices', () => {
  it('says each thing once per session', () => {
    const notify = vi.fn();
    notifyWebglOnce('webglContextLost', notify);
    notifyWebglOnce('webglContextLost', notify);
    expect(notify).toHaveBeenCalledTimes(1);

    notifyWebglOnce('webglUnavailable', notify);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
