export type BatchCommandMode = "whole" | "lines";

export type BatchCommandOptions = {
  mode: BatchCommandMode;
  intervalMs: number;
  repeat: number;
};

export type BatchCommandResult = {
  sent: number;
  total: number;
  cancelled: boolean;
};

export function batchCommandMessages(command: string, mode: BatchCommandMode): string[] {
  if (mode === "whole") return command ? [command] : [];
  const lines = command.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function waitForNextStep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, ms);
    function done() {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export async function sendBatchCommand(input: {
  command: string;
  targetIds: readonly string[];
  options: BatchCommandOptions;
  send: (sessionId: string, command: string) => Promise<unknown>;
  signal?: AbortSignal;
  onProgress?: (sent: number, total: number) => void;
}): Promise<BatchCommandResult> {
  const targets = Array.from(new Set(input.targetIds.filter(Boolean)));
  const messages = batchCommandMessages(input.command, input.options.mode);
  const repeat = Math.min(20, Math.max(1, Math.floor(input.options.repeat) || 1));
  const intervalMs = Math.min(10_000, Math.max(0, Math.floor(input.options.intervalMs) || 0));
  const total = targets.length * messages.length * repeat;
  let sent = 0;
  input.onProgress?.(sent, total);

  const steps = repeat * messages.length;
  for (let step = 0; step < steps; step += 1) {
    if (input.signal?.aborted) return { sent, total, cancelled: true };
    const command = messages[step % messages.length];
    const results = await Promise.allSettled(targets.map((sessionId) => input.send(sessionId, command)));
    sent += targets.length;
    input.onProgress?.(sent, total);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (step < steps - 1) await waitForNextStep(intervalMs, input.signal);
  }
  return { sent, total, cancelled: input.signal?.aborted === true };
}
