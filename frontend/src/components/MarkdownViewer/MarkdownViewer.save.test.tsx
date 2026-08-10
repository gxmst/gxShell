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
    <textarea
      aria-label="Source editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
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
});
