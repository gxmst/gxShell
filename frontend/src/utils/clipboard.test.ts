import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipboardSetText } from '../../wailsjs/runtime/runtime';
import { writeClipboardText } from './clipboard';

vi.mock('../../wailsjs/runtime/runtime', () => ({
  ClipboardSetText: vi.fn(),
}));

const nativeWrite = vi.mocked(ClipboardSetText);
const browserWrite = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  nativeWrite.mockReset();
  browserWrite.mockReset();
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
});
