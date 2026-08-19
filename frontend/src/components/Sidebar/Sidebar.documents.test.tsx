import { render, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Sidebar } from './Sidebar';

function sidebarProps(overrides: Partial<ComponentProps<typeof Sidebar>> = {}): ComponentProps<typeof Sidebar> {
  const noOp = vi.fn();
  return {
    collapsed: false,
    setCollapsed: noOp,
    setCtxMenu: noOp,
    drawer: 'sftp',
    setDrawer: noOp,
    profiles: [],
    commands: [],
    settings: null,
    appInfo: { version: '1.5.6' },
    active: {
      id: 'document-1',
      profileId: '',
      title: 'manual.pdf',
      state: 'connected',
      type: 'markdown',
      markdownSource: 'local',
      filePath: 'C:\\DOCS\\manual.PDF',
    },
    remotePath: '.',
    remoteFiles: [],
    sftpBusy: false,
    markdownSiblings: [
      ...Array.from({ length: 40 }, (_, index) => `C:\\docs\\note-${index}.txt`),
      'c:/docs/manual.pdf',
    ],
    recentMarkdown: [],
    onNewProfile: noOp,
    onQuickConnect: noOp,
    onEditProfile: noOp,
    onConnectProfile: noOp,
    onToggleFavorite: noOp,
    onDeleteProfile: noOp,
    onImportProfiles: noOp,
    onImportOpenSSH: noOp,
    onExportProfiles: noOp,
    onOpenSearch: noOp,
    onStartMonitor: noOp,
    onRefreshSftp: noOp,
    onNotify: noOp,
    onRunCommand: noOp,
    onRunCommandInSession: noOp,
    onRunCommandAll: noOp,
    onEditCommand: noOp,
    onDeleteCommand: noOp,
    onNewCommand: noOp,
    onSaveSettings: noOp,
    onOpenData: noOp,
    onOpenLog: noOp,
    getTerminalLines: () => '',
    activeTabId: 'document-1',
    tabs: [],
    ...overrides,
  };
}

describe('Sidebar document workspace', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    scrollIntoView.mockReset();
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
  });

  it('includes a local PDF, marks it current, and scrolls it into view', async () => {
    const { container } = render(<Sidebar {...sidebarProps()} />);

    const current = await waitFor(() => {
      const element = container.querySelector<HTMLButtonElement>('.text-file-row[aria-current="page"]');
      expect(element).not.toBeNull();
      return element!;
    });

    expect(current).toHaveAttribute('title', 'c:/docs/manual.pdf');
    expect(current).toHaveTextContent('manual.pdf');
    expect(container).toHaveTextContent('Local and remote document workspace');
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' }));
  });

  it('keeps case-sensitive local paths distinct off Windows', () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' });
    const { container } = render(<Sidebar {...sidebarProps({
      active: {
        ...sidebarProps().active!,
        title: 'A.txt',
        filePath: '/docs/A.txt',
      },
      markdownSiblings: ['/docs/a.txt', '/docs/A.txt'],
    })} />);

    expect(container.querySelectorAll('.text-file-row[aria-current="page"]')).toHaveLength(1);
    expect(container.querySelector('.text-file-row[aria-current="page"]')).toHaveAttribute('title', '/docs/A.txt');
  });
});
