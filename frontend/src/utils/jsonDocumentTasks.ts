import type { JsonDocumentMode, JsonFormatResult, JsonValidationResult } from './jsonDocuments';

export const MAX_SYNC_JSON_CHARS = 256 * 1024;
export type JsonDocumentTask = { action: 'validate' | 'format'; text: string; mode: JsonDocumentMode };
export type JsonDocumentTaskReply = { result: JsonValidationResult | JsonFormatResult } | { error: string };

async function runTask(task: JsonDocumentTask, signal?: AbortSignal): Promise<JsonValidationResult | JsonFormatResult> {
  signal?.throwIfAborted();
  if (task.text.length <= MAX_SYNC_JSON_CHARS) {
    const parser = await import('./jsonDocuments');
    signal?.throwIfAborted();
    return task.action === 'validate' ? parser.validateJsonDocument(task.text, task.mode) : parser.formatJsonDocument(task.text, task.mode);
  }

  // A worker belongs to one operation, so closing/changing a document can
  // terminate parsing immediately without leaving a queue of stale jobs.
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./jsonDocument.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      reject(new Error('GX_DOCUMENT_TASK_FAILED'));
      return;
    }
    let settled = false;
    const finish = (reply?: JsonDocumentTaskReply, error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', cancel);
      worker.terminate();
      if (error) reject(error);
      else if (reply && 'result' in reply) resolve(reply.result);
      else reject(new Error('GX_DOCUMENT_TASK_FAILED'));
    };
    const cancel = () => finish(undefined, new DOMException('Document operation cancelled', 'AbortError'));
    const timeout = window.setTimeout(() => finish(), 30_000);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = (event: MessageEvent<JsonDocumentTaskReply>) => finish(event.data);
    worker.onerror = (event) => { event.preventDefault(); finish(); };
    worker.onmessageerror = () => finish();
    try {
      worker.postMessage(task);
    } catch {
      finish();
    }
  });
}

export async function validateJsonDocument(text: string, mode: JsonDocumentMode, signal?: AbortSignal): Promise<JsonValidationResult> {
  return await runTask({ action: 'validate', text, mode }, signal) as JsonValidationResult;
}

export async function formatJsonDocument(text: string, mode: JsonDocumentMode, signal?: AbortSignal): Promise<JsonFormatResult> {
  return await runTask({ action: 'format', text, mode }, signal) as JsonFormatResult;
}
