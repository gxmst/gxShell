import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownViewer from './MarkdownViewer';
import { memoryStorage } from '../../test/memoryStorage';
import { resetDocumentAppearance } from '../../utils/documentReadingState';

const appMocks = vi.hoisted(() => ({ readLocalFile: vi.fn() }));

vi.mock('../../../wailsjs/go/app/App', () => ({
  ReadLocalFile: async (path: string) => ({ content: await appMocks.readLocalFile(path), version: 'v1' }),
  ReadLocalMarkdownResourceDataURL: vi.fn(),
  ReadRemoteTextFile: vi.fn(),
  ReadRemoteMarkdownResourceDataURL: vi.fn(),
  ResolveLocalMarkdownLink: vi.fn(),
  ResolveRemoteMarkdownLink: vi.fn(),
  WriteLocalFile: vi.fn(async () => ({ saved: true, conflict: false, version: 'v1' })),
  WriteRemoteTextFile: vi.fn(async () => ({ saved: true, conflict: false, version: 'v1' })),
}));

vi.mock('./markdownRenderer', () => ({
  buildMarkdown: (text: string) => ({ html: `<p>${text}</p>`, toc: [] }),
  sanitizeMermaidSVG: (svg: string) => svg,
}));

async function mountViewer(path: string) {
  const result = render(<MarkdownViewer active filePath={path} onClose={vi.fn()} />);
  await waitFor(() => expect(result.container.querySelector('.markdown-viewer')).toBeTruthy());
  return result;
}

/** Both viewers render the same controls, so every query names its pane. */
const pane = (index: number) => document.querySelectorAll<HTMLElement>('.markdown-viewer')[index];

const appearanceButton = (viewer: HTMLElement) =>
  within(viewer).getByRole('button', { name: 'Typography' });

const zoomReadout = (viewer: HTMLElement) => appearanceButton(viewer).textContent || '';

function openAppearance(viewer: HTMLElement) {
  fireEvent.click(appearanceButton(viewer));
  return viewer.querySelector<HTMLElement>('.markdown-appearance-popover')!;
}

const zoomSlider = (popover: HTMLElement) =>
  within(popover).getByRole('slider', { name: 'Document zoom' }) as HTMLInputElement;

const lineSpacing = (popover: HTMLElement) =>
  within(popover).getByRole('combobox', { name: 'Line spacing' }) as HTMLSelectElement;

describe('document appearance is one setting shared by every viewer', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    resetDocumentAppearance();
    Range.prototype.getClientRects = vi.fn(() => []) as unknown as typeof Range.prototype.getClientRects;
    Range.prototype.getBoundingClientRect = vi.fn(() => new DOMRect()) as unknown as typeof Range.prototype.getBoundingClientRect;
    appMocks.readLocalFile.mockReset();
    appMocks.readLocalFile.mockResolvedValue('# Notes\n\nA short document.\n');
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows a zoom set in one pane in the other pane as well', async () => {
    await mountViewer('/docs/first.md');
    await mountViewer('/docs/second.md');
    const first = pane(0);
    const second = pane(1);
    expect(zoomReadout(first)).toContain('100%');

    fireEvent.change(zoomSlider(openAppearance(first)), { target: { value: '1.5' } });

    expect(zoomReadout(first)).toContain('150%');
    expect(zoomReadout(second)).toContain('150%');
  });

  it('leaves the other pane\'s zoom alone when the line spacing changes', async () => {
    // The bug this replaced: each viewer wrote the whole appearance back from
    // its own copy, so setting the line spacing in the second pane restored the
    // first pane's stale 100% zoom over the 150% that had just been set.
    await mountViewer('/docs/first.md');
    await mountViewer('/docs/second.md');
    const first = pane(0);
    const second = pane(1);

    fireEvent.change(zoomSlider(openAppearance(first)), { target: { value: '1.5' } });
    fireEvent.change(lineSpacing(openAppearance(second)), { target: { value: '2.1' } });

    expect(zoomReadout(first)).toContain('150%');
    expect(zoomReadout(second)).toContain('150%');
    expect(JSON.parse(localStorage.getItem('gx:documentAppearance')!)).toEqual({
      zoom: 1.5,
      leading: 2.1,
      width: 'comfortable',
    });
  });

  it('keeps the typography when the document is reopened', async () => {
    const first = await mountViewer('/docs/first.md');
    fireEvent.change(zoomSlider(openAppearance(pane(0))), { target: { value: '1.5' } });
    first.unmount();

    await mountViewer('/docs/first.md');
    expect(zoomReadout(pane(0))).toContain('150%');
  });
});
