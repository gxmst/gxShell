import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownViewer from './MarkdownViewer';

const appMocks = vi.hoisted(() => ({
  readLocalFile: vi.fn(),
}));

const rendererMocks = vi.hoisted(() => ({
  buildMarkdown: vi.fn(),
  sanitizeMermaidSVG: vi.fn((svg: string) => svg),
}));

vi.mock('../../../wailsjs/go/app/App', () => ({
  ReadLocalFile: appMocks.readLocalFile,
  ReadLocalMarkdownResourceDataURL: vi.fn(),
  ReadRemoteTextFile: vi.fn(),
  ReadRemoteMarkdownResourceDataURL: vi.fn(),
  ResolveLocalMarkdownLink: vi.fn(),
  ResolveRemoteMarkdownLink: vi.fn(),
  WriteLocalFile: vi.fn(),
  WriteRemoteTextFile: vi.fn(),
}));

vi.mock('./markdownRenderer', () => ({
  buildMarkdown: rendererMocks.buildMarkdown,
  sanitizeMermaidSVG: rendererMocks.sanitizeMermaidSVG,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe('MarkdownViewer deferred rendering', () => {
  beforeEach(() => {
    appMocks.readLocalFile.mockReset();
    rendererMocks.buildMarkdown.mockReset();
    rendererMocks.buildMarkdown.mockImplementation((text: string) => ({
      html: `<p>${text}</p>`,
      toc: [],
    }));
  });

  it('does not parse a hidden Markdown tab until it becomes active', async () => {
    appMocks.readLocalFile.mockResolvedValue('hidden document');
    const props = { filePath: 'C:\\hidden.md', onClose: vi.fn() };
    const { rerender } = render(<MarkdownViewer active={false} {...props} />);

    await waitFor(() => expect(appMocks.readLocalFile).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(rendererMocks.buildMarkdown).not.toHaveBeenCalled();

    rerender(<MarkdownViewer active {...props} />);
    await waitFor(() => expect(rendererMocks.buildMarkdown).toHaveBeenCalledWith('hidden document'));
  });

  it('renders a visible split Markdown pane without enabling its global shortcuts', async () => {
    appMocks.readLocalFile.mockResolvedValue('split document');
    const { container } = render(<MarkdownViewer active={false} visible filePath={'C:\\split.md'} onClose={vi.fn()} />);

    await waitFor(() => expect(rendererMocks.buildMarkdown).toHaveBeenCalledWith('split document'));
    expect(container.querySelector('.markdown-viewer')).toHaveAttribute('data-active', 'false');
    expect(container.querySelector('.markdown-viewer')).toHaveAttribute('data-visible', 'true');
  });

  it('does not let a stale render overwrite a newer document', async () => {
    const firstRender = deferred<{ html: string; toc: [] }>();
    const secondRender = deferred<{ html: string; toc: [] }>();
    appMocks.readLocalFile.mockImplementation((path: string) => (
      Promise.resolve(path.endsWith('first.md') ? 'first source' : 'second source')
    ));
    rendererMocks.buildMarkdown.mockImplementation((text: string) => {
      if (!text) return { html: '', toc: [] };
      return text === 'first source' ? firstRender.promise : secondRender.promise;
    });

    const { rerender } = render(
      <MarkdownViewer active filePath={'C:\\first.md'} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(rendererMocks.buildMarkdown).toHaveBeenCalledWith('first source'));

    rerender(<MarkdownViewer active filePath={'C:\\second.md'} onClose={vi.fn()} />);
    await waitFor(() => expect(rendererMocks.buildMarkdown).toHaveBeenCalledWith('second source'));

    await act(async () => { secondRender.resolve({ html: '<p>new result</p>', toc: [] }); });
    expect(screen.getByText('new result')).toBeInTheDocument();

    await act(async () => { firstRender.resolve({ html: '<p>stale result</p>', toc: [] }); });
    expect(screen.getByText('new result')).toBeInTheDocument();
    expect(screen.queryByText('stale result')).not.toBeInTheDocument();
  });
});
