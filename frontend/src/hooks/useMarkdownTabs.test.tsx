import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drawer, Tab } from '../types';
import { useMarkdownTabs } from './useMarkdownTabs';

const appMocks = vi.hoisted(() => ({
  listLocal: vi.fn(),
  listRemote: vi.fn(),
}));

vi.mock('../../wailsjs/go/app/App', () => ({
  ListRemoteTextFilesInDir: appMocks.listRemote,
  ListTextFilesInDir: appMocks.listLocal,
  OpenRecentTextFile: vi.fn(),
  RestoreTextFiles: vi.fn().mockResolvedValue([]),
  SelectTextFile: vi.fn(),
}));

function useHarness() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState('');
  const documents = useMarkdownTabs({
    tabs,
    activeTab,
    profiles: [],
    language: 'en',
    setTabs,
    setActiveTab,
    setDrawer: vi.fn<(drawer: Drawer) => void>(),
    notify: vi.fn(),
  });
  return { activeTab, documents, tabs };
}

describe('useMarkdownTabs sibling loading', () => {
  const originalPlatform = navigator.platform;

  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
      removeItem: (key: string) => { values.delete(key); },
    });
    appMocks.listLocal.mockReset().mockResolvedValue(['C:\\docs\\notes.txt']);
    appMocks.listRemote.mockReset().mockResolvedValue(['/srv/notes.txt']);
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: originalPlatform });
    vi.unstubAllGlobals();
  });

  it('lists a local directory once when opening a new document', async () => {
    const { result } = renderHook(() => useHarness());

    await act(async () => {
      await result.current.documents.openMarkdownFile('C:\\docs\\notes.txt');
    });

    await waitFor(() => expect(appMocks.listLocal).toHaveBeenCalledTimes(1));
    expect(appMocks.listLocal).toHaveBeenCalledWith('C:\\docs\\notes.txt');
  });

  it('lists a remote directory once when opening a new document', async () => {
    const { result } = renderHook(() => useHarness());

    await act(async () => {
      await result.current.documents.openRemoteMarkdownFile('session-1', '/srv/notes.txt');
    });

    await waitFor(() => expect(appMocks.listRemote).toHaveBeenCalledTimes(1));
    expect(appMocks.listRemote).toHaveBeenCalledWith('session-1', '/srv/notes.txt');
  });

  it('ignores an older directory response after the active document changes', async () => {
    let resolveFirst!: (paths: string[]) => void;
    const first = new Promise<string[]>((resolve) => { resolveFirst = resolve; });
    appMocks.listRemote
      .mockReset()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(['/second/current.pdf']);
    const { result } = renderHook(() => useHarness());

    await act(async () => {
      await result.current.documents.openRemoteMarkdownFile('session-1', '/first/old.pdf');
    });
    await waitFor(() => expect(appMocks.listRemote).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.documents.openRemoteMarkdownFile('session-1', '/second/current.pdf');
    });
    await waitFor(() => expect(result.current.documents.markdownSiblings).toEqual(['/second/current.pdf']));

    await act(async () => { resolveFirst(['/first/old.pdf']); });
    expect(result.current.documents.markdownSiblings).toEqual(['/second/current.pdf']);
  });

  it('deduplicates local Windows paths regardless of slash style or case', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    const { result } = renderHook(() => useHarness());

    await act(async () => {
      await result.current.documents.openMarkdownFile('C:\\DOCS\\manual.PDF');
    });
    await act(async () => {
      await result.current.documents.openMarkdownFile('c:/docs/manual.pdf');
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(result.current.tabs[0].filePath).toBe('C:\\DOCS\\manual.PDF');
    expect(result.current.documents.recentMarkdown).toHaveLength(1);
  });

  it('keeps differently cased local paths distinct on case-sensitive platforms', async () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    const { result } = renderHook(() => useHarness());

    await act(async () => {
      await result.current.documents.openMarkdownFile('/docs/A.txt');
      await result.current.documents.openMarkdownFile('/docs/a.txt');
    });

    expect(result.current.tabs).toHaveLength(2);
    expect(result.current.documents.recentMarkdown).toHaveLength(2);
  });
});
