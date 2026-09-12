import { act, fireEvent, render } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
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
        mode="plain"
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

  it('reconfigures JSON highlighting without rebuilding the editor', () => {
    const props = {
      value: '{"enabled":true}',
      onChange: vi.fn(),
      onSave: vi.fn(),
      fontSize: 14,
      wrap: false,
    };
    const { container, rerender } = render(<SourceEditor {...props} mode="plain" />);
    const editor = container.querySelector('.cm-editor');
    const plainSpanCount = container.querySelectorAll('.cm-line span').length;

    rerender(<SourceEditor {...props} mode="json" />);

    expect(container.querySelector('.cm-editor')).toBe(editor);
    expect(container.querySelectorAll('.cm-line span').length).toBeGreaterThan(plainSpanCount);
  });

  it('keeps read-only previews selectable while rejecting edit commands and accepting a reload', () => {
    const handle = createRef<SourceEditorHandle>();
    const onChange = vi.fn();
    const onSave = vi.fn();
    const props = { handleRef: handle, onChange, onSave, fontSize: 13, wrap: false, mode: 'plain' as const, ariaLabel: 'Preview' };
    const { container, rerender } = render(<SourceEditor {...props} value="original" readOnly />);
    const content = container.querySelector<HTMLElement>('.cm-content')!;
    const view = EditorView.findFromDOM(content)!;
    expect(content).toHaveAttribute('contenteditable', 'false');
    expect(content).toHaveAttribute('aria-readonly', 'true');
    act(() => {
      handle.current?.selectAll();
      handle.current?.insertText('overwrite');
      handle.current?.toggleWrap('**');
      handle.current?.setHeading(1);
      handle.current?.insertLink();
    });
    fireEvent.keyDown(content, { key: 's', ctrlKey: true });
    expect(view.state.doc.toString()).toBe('original');
    expect(view.state.selection.main.to).toBe('original'.length);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();
    expect(wordCountMock).not.toHaveBeenCalled();

    rerender(<SourceEditor {...props} value="reloaded" readOnly />);
    expect(view.state.doc.toString()).toBe('reloaded');
    expect(onChange).not.toHaveBeenCalled();
    rerender(<SourceEditor {...props} value="reloaded" />);
    expect(content).toHaveAttribute('contenteditable', 'true');
    act(() => handle.current?.insertText('edited'));
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
