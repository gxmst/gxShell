import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../../test/memoryStorage';
import MarkdownViewer from './MarkdownViewer';

// The find bar re-runs its search on every edit, because the matches move. What
// it must NOT do is move the user: while editing, re-revealing on each keystroke
// drags the CodeMirror caret to the first match and the next character typed
// lands there instead of where the user was working.
//
// The existing viewer tests cannot catch this: their SourceEditor mock exposes
// no handle, so revealRange is never reachable. This one provides one.

const revealRange = vi.hoisted(() => vi.fn());

const appMocks = vi.hoisted(() => ({ readLocalFile: vi.fn() }));

vi.mock('../../../wailsjs/go/app/App', () => ({
  ReadLocalFile: appMocks.readLocalFile,
  ReadLocalPDFBase64: vi.fn(),
  ReadLocalMarkdownResourceDataURL: vi.fn(),
  ReadRemoteTextFile: vi.fn(),
  ReadRemoteMarkdownResourceDataURL: vi.fn(),
  ResolveLocalMarkdownLink: vi.fn(),
  ResolveRemoteMarkdownLink: vi.fn(),
  WriteLocalFile: vi.fn(),
  WriteRemoteTextFile: vi.fn(),
}));

vi.mock('./SourceEditor', () => ({
  default: ({ handleRef, value, onChange, readOnly, ariaLabel }: {
    handleRef?: (handle: unknown) => void;
    value: string;
    onChange: (value: string) => void;
    readOnly?: boolean;
    ariaLabel?: string;
  }) => {
    const handle = {
      focus: () => undefined,
      selectAll: () => undefined,
      scrollRatio: () => 0,
      setScrollRatio: () => undefined,
      scrollPosition: () => null,
      setScrollPosition: () => undefined,
      revealRange: (from: number, to: number) => revealRange(from, to),
      toggleWrap: () => undefined,
      setHeading: () => undefined,
      insertLink: () => undefined,
      insertText: () => undefined,
      undo: () => undefined,
      redo: () => undefined,
    };
    // A callback ref, exactly as the real component is mounted.
    if (handleRef) handleRef(handle);
    return (
      <textarea
        aria-label={ariaLabel || 'Source editor'}
        readOnly={readOnly}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  },
}));

describe('MarkdownViewer find bar while editing', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    appMocks.readLocalFile.mockReset();
    revealRange.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('rescans on an edit without stealing the caret, and still reveals on next', async () => {
    const text = 'alpha beta alpha gamma alpha';
    appMocks.readLocalFile.mockResolvedValue(text);
    const { container } = render(
      <MarkdownViewer active locale="en" filePath={'C:\\notes.txt'} onClose={vi.fn()} />,
    );

    fireEvent.click(await screen.findByTitle('Edit'));
    const editor = await screen.findByLabelText('Source editor');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    const input = screen.getByPlaceholderText('Find');

    // A new query reveals its first match.
    fireEvent.change(input, { target: { value: 'alpha' } });
    await waitFor(() => expect(container.querySelector('.markdown-search-count')).toHaveTextContent('1/3'));
    expect(revealRange).toHaveBeenCalled();
    expect(revealRange).toHaveBeenLastCalledWith(0, 5);

    // Editing re-runs the search but must leave the caret alone.
    revealRange.mockClear();
    fireEvent.change(editor, { target: { value: `${text} alpha` } });
    await waitFor(() => expect(container.querySelector('.markdown-search-count')).toHaveTextContent('1/4'));
    expect(revealRange).not.toHaveBeenCalled();

    // An explicit move still works.
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(container.querySelector('.markdown-search-count')).toHaveTextContent('2/4'));
    expect(revealRange).toHaveBeenCalledTimes(1);
  });

  it('re-reveals the first match when the query changes', async () => {
    appMocks.readLocalFile.mockResolvedValue('alpha beta alpha');
    const { container } = render(
      <MarkdownViewer active locale="en" filePath={'C:\\notes.txt'} onClose={vi.fn()} />,
    );

    fireEvent.click(await screen.findByTitle('Edit'));
    await screen.findByLabelText('Source editor');
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    const input = screen.getByPlaceholderText('Find');

    fireEvent.change(input, { target: { value: 'alpha' } });
    await waitFor(() => expect(container.querySelector('.markdown-search-count')).toHaveTextContent('1/2'));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(container.querySelector('.markdown-search-count')).toHaveTextContent('2/2'));

    revealRange.mockClear();
    fireEvent.change(input, { target: { value: 'beta' } });
    await waitFor(() => expect(container.querySelector('.markdown-search-count')).toHaveTextContent('1/1'));
    // A different query starts over at its own first match.
    expect(revealRange).toHaveBeenLastCalledWith(6, 10);
  });
});
