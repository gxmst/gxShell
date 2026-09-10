import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { renderMermaid } from './mermaidRenderer';

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock('mermaid', () => ({ default: mermaid }));

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120"><text>中文</text></svg>';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => { mermaid.initialize.mockClear(); mermaid.render.mockReset(); });

describe('Mermaid render lifecycle', () => {
  it('serializes theme configuration, cancels stale jobs and removes measuring containers', async () => {
    const first = deferred<{ svg: string }>();
    mermaid.render.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ svg });
    const controller = new AbortController();
    const old = renderMermaid('first', 'default', controller.signal);
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1));
    const next = renderMermaid('second', 'dark', new AbortController().signal);
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    controller.abort();
    first.resolve({ svg });
    expect(await old).toBeNull();
    expect(await next).toMatchObject({ width: 300, height: 120 });
    expect(mermaid.initialize.mock.calls.map(([config]) => config.theme)).toEqual(['default', 'dark']);
    expect(mermaid.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true }));
    expect(document.querySelector('.md-mermaid-measure')).toBeNull();
  });

  it('continues after a parse error and skips already cancelled work', async () => {
    mermaid.render.mockRejectedValueOnce(new Error('Parse error on line 2')).mockResolvedValueOnce({ svg });
    await expect(renderMermaid('broken', 'default', new AbortController().signal)).rejects.toThrow('line 2');
    expect(document.querySelector('.md-mermaid-measure')).toBeNull();
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await renderMermaid('unused', 'dark', cancelled.signal)).toBeNull();
    const drawing = await renderMermaid('valid', 'default', new AbortController().signal);
    expect(drawing?.svg).toContain('中文');
    expect(mermaid.render).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.md-mermaid-measure')).toBeNull();
  });
});
