import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceEditor, type SourceEditorHandle } from './SourceEditor';

const wordCountMock = vi.hoisted(() => vi.fn((text: string) => text.trim().split(/\s+/).filter(Boolean).length));

vi.mock('../../utils/wordCount', () => ({ countWords: wordCountMock }));

describe('SourceEditor statistics', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wordCountMock.mockClear();
    Range.prototype.getClientRects = vi.fn(() => []) as unknown as typeof Range.prototype.getClientRects;
    Range.prototype.getBoundingClientRect = vi.fn(() => new DOMRect()) as unknown as typeof Range.prototype.getBoundingClientRect;
  });

  afterEach(() => vi.useRealTimers());

  it('does not rescan the document on selection-only updates', () => {
    const handle = createRef<SourceEditorHandle>();
    render(
      <SourceEditor
        handleRef={handle}
        value="alpha beta"
        onChange={vi.fn()}
        onSave={vi.fn()}
        onStats={vi.fn()}
        fontSize={14}
        wrap={false}
        markdownMode={false}
      />,
    );
    expect(wordCountMock).toHaveBeenCalledTimes(1);

    act(() => handle.current?.revealRange(0, 5));
    expect(wordCountMock).toHaveBeenCalledTimes(1);

    act(() => {
      handle.current?.insertText('gamma ');
      vi.advanceTimersByTime(239);
    });
    expect(wordCountMock).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(wordCountMock).toHaveBeenCalledTimes(2);
  });
});
