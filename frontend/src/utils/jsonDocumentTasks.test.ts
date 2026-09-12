import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentTestWorker } from '../test/documentWorker';
import { formatJsonDocument, validateJsonDocument } from './jsonDocumentTasks';

const large = '{"big":9007199254740993}\n'.repeat(15_000);

describe('asynchronous JSON document work', () => {
  beforeEach(() => {
    DocumentTestWorker.instances = [];
    vi.stubGlobal('Worker', DocumentTestWorker);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('validates small JSON without a worker and sends large JSONL to a worker', async () => {
    expect(await validateJsonDocument('{"ok":true}', 'json')).toEqual({ valid: true });
    expect(DocumentTestWorker.instances).toHaveLength(0);
    const result = validateJsonDocument(large, 'jsonl');
    const worker = DocumentTestWorker.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith({ action: 'validate', text: large, mode: 'jsonl' });
    const error = { code: 'syntax' as const, offset: large.length - 2, line: 15_000, column: 23 };
    worker.reply({ result: { valid: false, error } });
    expect(await result).toEqual({ valid: false, error });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('returns formatted tokens unchanged and releases the completed worker', async () => {
    const result = formatJsonDocument(large, 'jsonl');
    const worker = DocumentTestWorker.instances[0];
    worker.reply({ result: { ok: true, text: large } });
    expect(await result).toEqual({ ok: true, text: large });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('terminates cancelled work and ignores its late result', async () => {
    const controller = new AbortController();
    const result = formatJsonDocument(large, 'jsonl', controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    const worker = DocumentTestWorker.instances[0];
    controller.abort();
    worker.reply({ result: { ok: true, text: 'stale' } });
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    await expect(validateJsonDocument(large, 'jsonl', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(DocumentTestWorker.instances).toHaveLength(1);
  });

  it('reports worker failure instead of blocking the UI with a synchronous fallback', async () => {
    const result = validateJsonDocument(large, 'jsonl');
    const rejected = expect(result).rejects.toThrow('GX_DOCUMENT_TASK_FAILED');
    const worker = DocumentTestWorker.instances[0];
    worker.onerror?.({ preventDefault: vi.fn() } as unknown as ErrorEvent);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
