import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownViewer from './MarkdownViewer';

const appMocks = vi.hoisted(() => ({
  readLocalFile: vi.fn(),
  readLocalPdf: vi.fn(),
  readLocalResource: vi.fn(),
  readRemoteFile: vi.fn(),
  readRemoteResource: vi.fn(),
  resolveLocalLink: vi.fn(),
  resolveRemoteLink: vi.fn(),
  writeLocalFile: vi.fn(),
  writeRemoteFile: vi.fn(),
}));

vi.mock('../../../wailsjs/go/app/App', () => ({
  ReadLocalFile: appMocks.readLocalFile,
  ReadLocalPDFBase64: appMocks.readLocalPdf,
  ReadLocalMarkdownResourceDataURL: appMocks.readLocalResource,
  ReadRemoteTextFile: appMocks.readRemoteFile,
  ReadRemoteMarkdownResourceDataURL: appMocks.readRemoteResource,
  ResolveLocalMarkdownLink: appMocks.resolveLocalLink,
  ResolveRemoteMarkdownLink: appMocks.resolveRemoteLink,
  WriteLocalFile: appMocks.writeLocalFile,
  WriteRemoteTextFile: appMocks.writeRemoteFile,
}));

vi.mock('./SourceEditor', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <div className="source-editor">
      <div className="cm-editor">
        <textarea
          aria-label="Source editor"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  ),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('MarkdownViewer saving', () => {
  beforeEach(() => {
    appMocks.readLocalFile.mockResolvedValue('original\n');
    appMocks.writeLocalFile.mockReset();
  });

  it('deduplicates concurrent saves and preserves edits made while a snapshot is being written', async () => {
    const firstWrite = deferred<void>();
    appMocks.writeLocalFile
      .mockReturnValueOnce(firstWrite.promise)
      .mockResolvedValueOnce(undefined);

    let saveCurrent = async () => false;
    const onDirtyChange = vi.fn((dirty: boolean, save: () => Promise<boolean>) => {
      if (dirty) saveCurrent = save;
    });

    const { container } = render(
      <MarkdownViewer
        active
        filePath={'C:\\notes.txt'}
        onClose={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );

    await screen.findByText('original');
    fireEvent.click(screen.getByTitle('Edit'));

    const editor = await screen.findByLabelText('Source editor');
    fireEvent.change(editor, { target: { value: 'first draft\n' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true, expect.any(Function)));

    let firstSave!: Promise<boolean>;
    let duplicateSave!: Promise<boolean>;
    act(() => {
      firstSave = saveCurrent();
      duplicateSave = saveCurrent();
    });

    expect(duplicateSave).toBe(firstSave);
    await waitFor(() => expect(appMocks.writeLocalFile).toHaveBeenCalledTimes(1));
    expect(appMocks.writeLocalFile).toHaveBeenCalledWith('C:\\notes.txt', 'first draft\n');

    // These changes happen after the write has started. They must remain in the
    // editor and must not be reported as saved by the first operation.
    fireEvent.change(editor, { target: { value: 'second draft\n' } });
    const eolButton = container.querySelector<HTMLButtonElement>('.source-editor-status-btn');
    expect(eolButton).not.toBeNull();
    fireEvent.click(eolButton!);
    expect(eolButton).toHaveTextContent('CRLF');

    let firstResult = true;
    await act(async () => {
      firstWrite.resolve();
      firstResult = await firstSave;
    });

    expect(firstResult).toBe(false);
    expect(screen.getByLabelText('Source editor')).toHaveValue('second draft\n');
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    let secondResult = false;
    await act(async () => {
      secondResult = await saveCurrent();
    });

    expect(secondResult).toBe(true);
    expect(appMocks.writeLocalFile).toHaveBeenCalledTimes(2);
    expect(appMocks.writeLocalFile).toHaveBeenLastCalledWith('C:\\notes.txt', 'second draft\r\n');
    await waitFor(() => expect(screen.queryByLabelText('Source editor')).not.toBeInTheDocument());
  });

  it('rejects invalid JSON before writing and reports the error in Chinese', async () => {
    appMocks.readLocalFile.mockResolvedValue('{"ok":true}\n');
    const onNotify = vi.fn();
    let saveCurrent = async () => false;
    const onDirtyChange = vi.fn((dirty: boolean, save: () => Promise<boolean>) => {
      if (dirty) saveCurrent = save;
    });

    render(
      <MarkdownViewer
        active
        locale="zh-CN"
        filePath={'C:\\settings.json'}
        onClose={vi.fn()}
        onNotify={onNotify}
        onDirtyChange={onDirtyChange}
      />,
    );

    await screen.findByText('{"ok":true}');
    fireEvent.click(screen.getByTitle('Edit'));
    const editor = await screen.findByLabelText('Source editor');
    fireEvent.change(editor, { target: { value: '{"ok":}' } });
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(true, expect.any(Function)));

    let saved = true;
    await act(async () => { saved = await saveCurrent(); });

    expect(saved).toBe(false);
    expect(appMocks.writeLocalFile).not.toHaveBeenCalled();
    expect(onNotify).toHaveBeenCalledWith('JSON 格式错误：第 1 行，第 7 列', 'error');
  });

  it('formats JSON from the localized toolbar command', async () => {
    appMocks.readLocalFile.mockResolvedValue('{"a":1,"nested":{"ok":true}}');
    render(
      <MarkdownViewer active locale="zh-CN" filePath={'C:\\settings.json'} onClose={vi.fn()} />,
    );

    await screen.findByText('{"a":1,"nested":{"ok":true}}');
    fireEvent.click(screen.getByTitle('Edit'));
    const editor = await screen.findByLabelText('Source editor');
    fireEvent.click(screen.getByTitle('格式化 JSON'));

    await waitFor(() => expect(editor).toHaveValue(`{
  "a": 1,
  "nested": {
    "ok": true
  }
}`));
  });

  it('defers live validation for large JSON while retaining save-time validation', async () => {
    appMocks.readLocalFile.mockResolvedValue(`{"payload":"${'x'.repeat(256 * 1024)}"}`);
    render(
      <MarkdownViewer active filePath={'C:\\large.json'} onClose={vi.fn()} />,
    );

    fireEvent.click(await screen.findByTitle('Edit'));
    expect(await screen.findByText('Large document: validate on save')).toBeInTheDocument();
  });
});

describe('MarkdownViewer PDF browsing', () => {
  beforeEach(() => {
    appMocks.readLocalFile.mockClear();
    appMocks.readRemoteFile.mockClear();
  });

  it('opens a local PDF through the authorized range-streaming asset route', async () => {
    render(
      <MarkdownViewer active source="local" filePath={'C:\\docs\\manual #1.pdf'} onClose={vi.fn()} />,
    );

    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('.pdf-viewer-frame');
      expect(element).not.toBeNull();
      return element!;
    });
    const src = frame.getAttribute('src') || '';
    expect(src).toContain('/__gxshell/document/pdf?');
    expect(src).toContain('path=C%3A%5Cdocs%5Cmanual%20%231.pdf');
    expect(appMocks.readLocalFile).not.toHaveBeenCalled();
  });

  it('opens a remote PDF through the range-streaming asset route', async () => {
    render(
      <MarkdownViewer
        active
        source="remote"
        sessionId="session 5"
        remotePath="/srv/docs/a #1.pdf"
        onClose={vi.fn()}
      />,
    );

    const frame = await waitFor(() => {
      const element = document.querySelector<HTMLIFrameElement>('.pdf-viewer-frame');
      expect(element).not.toBeNull();
      return element!;
    });
    const src = frame.getAttribute('src') || '';
    expect(src).toContain('/__gxshell/document/remote-pdf?');
    expect(src).toContain('sessionId=session%205');
    expect(src).toContain('path=%2Fsrv%2Fdocs%2Fa%20%231.pdf');
    expect(appMocks.readRemoteFile).not.toHaveBeenCalled();
  });
});

describe('MarkdownViewer performance-sensitive interactions', () => {
  beforeEach(() => {
    appMocks.readLocalFile.mockReset();
    appMocks.readLocalResource.mockReset();
    appMocks.readLocalResource.mockResolvedValue('data:image/png;base64,cG5n');
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('previews pointer zoom with a transform and commits layout on release', async () => {
    appMocks.readLocalFile.mockResolvedValue('# Heading\n\nBody\n');
    const { container } = render(
      <MarkdownViewer active filePath={'C:\\notes.md'} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getAllByText('Heading')).toHaveLength(2));

    const input = screen.getByLabelText('Document zoom') as HTMLInputElement;
    const viewer = container.querySelector<HTMLElement>('.markdown-viewer')!;
    const document = container.querySelector<HTMLElement>('.md-document')!;
    expect(document.style.zoom).toBe('1');

    fireEvent.pointerDown(input, { pointerId: 1 });
    fireEvent.input(input, { target: { value: '1.5' } });
    expect(viewer).toHaveClass('markdown-viewer-zooming');
    expect(viewer.style.getPropertyValue('--md-live-scale')).toBe('1.5');
    expect(document.style.zoom).toBe('1');

    fireEvent.pointerUp(input, { pointerId: 1 });
    await waitFor(() => expect(document.style.zoom).toBe('1.5'));
    expect(viewer).not.toHaveClass('markdown-viewer-zooming');
  });

  it('uses the same live zoom preview while editing', async () => {
    appMocks.readLocalFile.mockResolvedValue('plain text\n');
    const { container } = render(
      <MarkdownViewer active filePath={'C:\\notes.txt'} onClose={vi.fn()} />,
    );
    await screen.findByText('plain text');
    fireEvent.click(screen.getByTitle('Edit'));
    await screen.findByLabelText('Source editor');

    const input = screen.getByLabelText('Document zoom') as HTMLInputElement;
    const viewer = container.querySelector<HTMLElement>('.markdown-viewer')!;
    expect(container.querySelector('.source-editor .cm-editor')).not.toBeNull();

    fireEvent.pointerDown(input, { pointerId: 2 });
    fireEvent.input(input, { target: { value: '1.4' } });
    expect(viewer).toHaveClass('markdown-viewer-zooming');
    expect(viewer.style.getPropertyValue('--md-live-scale')).toBe('1.4');

    fireEvent.pointerUp(input, { pointerId: 2 });
    await waitFor(() => expect(viewer).not.toHaveClass('markdown-viewer-zooming'));
  });

  it('does not reload an already resolved image when the tab is reactivated', async () => {
    appMocks.readLocalFile.mockResolvedValue('![diagram](diagram.png)\n');
    const props = { filePath: 'C:\\notes.md', onClose: vi.fn() };
    const { rerender } = render(<MarkdownViewer active {...props} />);
    await waitFor(() => expect(appMocks.readLocalResource).toHaveBeenCalledTimes(1));

    rerender(<MarkdownViewer active={false} {...props} />);
    rerender(<MarkdownViewer active {...props} />);
    await act(async () => Promise.resolve());
    expect(appMocks.readLocalResource).toHaveBeenCalledTimes(1);
  });

  it('retries a failed image when the tab is reactivated', async () => {
    appMocks.readLocalFile.mockResolvedValue('![diagram](diagram.png)\n');
    appMocks.readLocalResource
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce('data:image/png;base64,cmV0cnk=');
    const props = { filePath: 'C:\\notes.md', onClose: vi.fn() };
    const { container, rerender } = render(<MarkdownViewer active {...props} />);
    await waitFor(() => {
      expect(appMocks.readLocalResource).toHaveBeenCalledTimes(1);
      expect(container.querySelector('img')).toHaveAttribute('data-md-loaded', 'error');
    });

    rerender(<MarkdownViewer active={false} {...props} />);
    rerender(<MarkdownViewer active {...props} />);
    await waitFor(() => {
      expect(appMocks.readLocalResource).toHaveBeenCalledTimes(2);
      expect(container.querySelector('img')).toHaveAttribute('data-md-loaded', 'true');
    });
  });
});
