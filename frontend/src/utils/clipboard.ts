import { ClipboardSetText } from '../../wailsjs/runtime/runtime';

type PlatformInfo = { platform?: string; userAgent?: string; userAgentDataPlatform?: string };

function currentPlatform(): PlatformInfo {
  if (typeof navigator === 'undefined') return {};
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return {
    platform: nav.platform,
    userAgent: nav.userAgent,
    userAgentDataPlatform: nav.userAgentData?.platform,
  };
}

export function isWindowsPlatform(info: PlatformInfo = currentPlatform()): boolean {
  return /^win/i.test(info.userAgentDataPlatform || '')
    || /^win/i.test(info.platform || '')
    || /windows/i.test(info.userAgent || '');
}

/** Convert line endings only for Win32 clipboard consumers. macOS/Linux
 * programmatic copies should preserve the source text exactly. */
export function toClipboardText(text: string, windows = isWindowsPlatform()): string {
  if (!windows) return text;
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
}

export async function writeClipboardText(text: string): Promise<void> {
  const payload = toClipboardText(text);

  try {
    if (await ClipboardSetText(payload)) return;
  } catch {
    // The Wails runtime is absent when the frontend runs in a regular browser.
  }

  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard is unavailable');
  }
  await navigator.clipboard.writeText(payload);
}
