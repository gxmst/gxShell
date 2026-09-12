import { useRef } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MermaidDiagrams } from './MermaidDiagrams';
import { buildMarkdown } from './markdownRenderer';
import type { MermaidDrawing } from './mermaidRenderer';

const mocks = vi.hoisted(() => ({ render: vi.fn(), copy: vi.fn().mockResolvedValue(undefined) }));
vi.mock('./mermaidRenderer', async (importOriginal) => ({
  ...await importOriginal<typeof import('./mermaidRenderer')>(), renderMermaid: mocks.render,
}));
vi.mock('../../utils/clipboard', () => ({ writeClipboardText: mocks.copy }));

function Harness({ text = 'flowchart TD\n A[中文] --> B[回答]', theme = 'Light', visible = true }: { text?: string; theme?: string; visible?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const html = buildMarkdown('```mermaid\n' + text + '\n```').html;
  return <div className="app-shell" data-theme={theme}>
    <div ref={root} dangerouslySetInnerHTML={{ __html: html }} />
    <MermaidDiagrams rootRef={root} html={html} visible={visible} previewKey="preview" locale="zh-CN" />
  </div>;
}

const drawing = (text: string): MermaidDrawing => ({ svg: `<svg viewBox="0 0 300 120"><text>${text}</text></svg>`, width: 300, height: 120 });
function deferred() {
  let resolve!: (value: MermaidDrawing) => void;
  const promise = new Promise<MermaidDrawing>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { mocks.render.mockReset(); mocks.copy.mockClear(); });

describe('Mermaid reading controls', () => {
  it('resets diagram zoom when its document content changes', async () => {
    mocks.render.mockResolvedValue(drawing('diagram label'));
    const { container, rerender } = render(<Harness text="flowchart TD\n A[document A] --> B" />);
    await screen.findByText('diagram label');
    fireEvent.click(screen.getByRole('button', { name: '100%' }));
    for (let index = 0; index < 6; index++) fireEvent.click(screen.getByRole('button', { name: '放大图表' }));
    expect(container.querySelector('.md-diagram-percent')).toHaveTextContent('220%');
    rerender(<Harness text="flowchart TD\n A[document B] --> B" />);
    await screen.findByText('diagram label');
    expect(container.querySelector('.md-diagram-percent')).toHaveTextContent('100%');
  });

  it('rejects stale results after a document changes', async () => {
    const old = deferred();
    const current = deferred();
    mocks.render.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { rerender } = render(<Harness text="flowchart TD\n A[old] --> B" />);
    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(1));
    const signal = mocks.render.mock.calls[0][2] as AbortSignal;
    rerender(<Harness text="flowchart TD\n A[new] --> B" />);
    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
    expect(signal.aborted).toBe(true);
    await act(async () => current.resolve(drawing('current label')));
    await act(async () => old.resolve(drawing('stale label')));
    expect(screen.getByText('current label')).toBeInTheDocument();
    expect(screen.queryByText('stale label')).not.toBeInTheDocument();
  });

  it('retains successful drawings across tab switches and avoids rendering on zoom', async () => {
    mocks.render.mockResolvedValue(drawing('cached label'));
    const { rerender } = render(<Harness />);
    await screen.findByText('cached label');
    fireEvent.click(screen.getByRole('button', { name: '放大图表' }));
    rerender(<Harness visible={false} />);
    rerender(<Harness visible />);
    await screen.findByText('cached label');
    expect(mocks.render).toHaveBeenCalledTimes(1);
  });

  it('restores the previous theme if a pending theme change is cancelled', async () => {
    const pending = deferred();
    mocks.render.mockResolvedValueOnce(drawing('light label')).mockReturnValueOnce(pending.promise);
    const { rerender } = render(<Harness />);
    await screen.findByText('light label');
    rerender(<Harness theme="Dark" />);
    await waitFor(() => expect(mocks.render).toHaveBeenCalledTimes(2));
    rerender(<Harness theme="Light" />);
    await screen.findByText('light label');
    await act(async () => pending.resolve(drawing('stale dark label')));
    expect(screen.queryByText('stale dark label')).not.toBeInTheDocument();
    expect(mocks.render).toHaveBeenCalledTimes(2);
  });

  it('keeps a failed diagram source copyable and supports retry', async () => {
    mocks.render.mockRejectedValueOnce(new Error('Parse error on line 2')).mockResolvedValueOnce(drawing('recovered label'));
    render(<Harness />);
    await screen.findByText('图表解析失败');
    expect(screen.getByLabelText('图表源码').textContent).toBe('flowchart TD\n A[中文] --> B[回答]');
    fireEvent.click(screen.getByRole('button', { name: '复制图表源码' }));
    await waitFor(() => expect(mocks.copy).toHaveBeenCalledWith('flowchart TD\n A[中文] --> B[回答]'));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('recovered label');
    expect(screen.queryByText('图表解析失败')).not.toBeInTheDocument();
  });
});
