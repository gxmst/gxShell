import { vi } from 'vitest';
import type { JsonDocumentTask, JsonDocumentTaskReply } from '../utils/jsonDocumentTasks';

export class DocumentTestWorker {
  static instances: DocumentTestWorker[] = [];
  onmessage: ((event: MessageEvent<JsonDocumentTaskReply>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn<(task: JsonDocumentTask) => void>();
  terminate = vi.fn();

  constructor() { DocumentTestWorker.instances.push(this); }

  reply(data: JsonDocumentTaskReply) {
    this.onmessage?.({ data } as MessageEvent<JsonDocumentTaskReply>);
  }
}
