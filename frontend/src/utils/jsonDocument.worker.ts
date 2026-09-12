import { formatJsonDocument, validateJsonDocument } from './jsonDocuments';
import type { JsonDocumentTask, JsonDocumentTaskReply } from './jsonDocumentTasks';

self.onmessage = (event: MessageEvent<JsonDocumentTask>) => {
  const { action, text, mode } = event.data;
  let reply: JsonDocumentTaskReply;
  try {
    reply = { result: action === 'validate' ? validateJsonDocument(text, mode) : formatJsonDocument(text, mode) };
  } catch {
    reply = { error: 'GX_DOCUMENT_TASK_FAILED' };
  }
  self.postMessage(reply);
};
