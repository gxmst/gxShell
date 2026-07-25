import { ClipboardSetText } from '../../wailsjs/runtime/runtime';

export async function writeClipboardText(text: string): Promise<void> {
  try {
    if (await ClipboardSetText(text)) return;
  } catch {
    // The Wails runtime is absent when the frontend runs in a regular browser.
  }

  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard is unavailable');
  }
  await navigator.clipboard.writeText(text);
}
