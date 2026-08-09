import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipboardSetText } from '../../wailsjs/runtime/runtime';
import { toClipboardText, writeClipboardText } from './clipboard';

vi.mock('../../wailsjs/runtime/runtime', () => ({
  ClipboardSetText: vi.fn(),
}));

const nativeWrite = vi.mocked(ClipboardSetText);
const browserWrite = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  nativeWrite.mockReset();
  browserWrite.mockReset();
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value: 'Win32',
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: browserWrite },
  });
});

describe('writeClipboardText', () => {
  it('uses the Wails clipboard bridge in the desktop app', async () => {
    nativeWrite.mockResolvedValue(true);

    await writeClipboardText('echo hello');

    expect(nativeWrite).toHaveBeenCalledWith('echo hello');
    expect(browserWrite).not.toHaveBeenCalled();
  });

  it('falls back to the browser clipboard outside Wails', async () => {
    nativeWrite.mockRejectedValue(new Error('Wails runtime unavailable'));
    browserWrite.mockResolvedValue();

    await writeClipboardText('echo hello');

    expect(browserWrite).toHaveBeenCalledWith('echo hello');
  });

  it('reports failure when neither clipboard implementation succeeds', async () => {
    nativeWrite.mockResolvedValue(false);
    browserWrite.mockRejectedValue(new Error('clipboard permission denied'));

    await expect(writeClipboardText('echo hello')).rejects.toThrow('clipboard permission denied');
  });

  // Neither the Wails bridge nor the async clipboard API converts line endings,
  // so multi-line text has to arrive as CRLF for Win32 paste targets.
  it('writes multi-line text as CRLF through the Wails bridge', async () => {
    nativeWrite.mockResolvedValue(true);

    await writeClipboardText('line one\nline two\n');

    expect(nativeWrite).toHaveBeenCalledWith('line one\r\nline two\r\n');
  });

  it('writes multi-line text as CRLF through the browser fallback', async () => {
    nativeWrite.mockResolvedValue(false);
    browserWrite.mockResolvedValue();

    await writeClipboardText('line one\nline two');

    expect(browserWrite).toHaveBeenCalledWith('line one\r\nline two');
  });

  it('preserves LF on non-Windows platforms', async () => {
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Linux x86_64',
    });
    nativeWrite.mockResolvedValue(true);

    await writeClipboardText('line one\nline two');

    expect(nativeWrite).toHaveBeenCalledWith('line one\nline two');
  });
});

describe('toClipboardText', () => {
  it('converts LF to CRLF', () => {
    expect(toClipboardText('a\nb\nc', true)).toBe('a\r\nb\r\nc');
  });

  it('does not double carriage returns in text that is already CRLF', () => {
    expect(toClipboardText('a\r\nb', true)).toBe('a\r\nb');
  });

  it('normalizes lone CR', () => {
    expect(toClipboardText('a\rb', true)).toBe('a\r\nb');
  });

  it('leaves single-line text untouched', () => {
    expect(toClipboardText('echo hello', true)).toBe('echo hello');
  });

  it('does not rewrite any line ending outside Windows', () => {
    const source = 'a\r\nb\nc\rd';
    expect(toClipboardText(source, false)).toBe(source);
  });
});
