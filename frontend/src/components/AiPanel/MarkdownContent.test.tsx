import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MarkdownContent } from './AiPanel';

vi.mock('../../../wailsjs/runtime/runtime', () => ({
  EventsOn: vi.fn(() => () => undefined),
  BrowserOpenURL: vi.fn(),
}));

vi.mock('../../../wailsjs/go/app/App', () => ({
  AiChat: vi.fn(),
  AiContinueChat: vi.fn(),
  AiExecuteTools: vi.fn(),
  CancelAiChat: vi.fn(),
  GetAiConfig: vi.fn(),
  GetAiUsage: vi.fn(),
  ListAiModels: vi.fn(),
  ResetAiUsage: vi.fn(),
  SaveAiConfig: vi.fn(),
}));

// A reply is not trusted input. The assistant reads command output and file
// contents, so anything it read can steer what it writes back — and a reply is
// rendered next to the approval panel. Before this was fixed, the panel used
// DOMPurify's defaults, which keep a stylesheet (so the panel could be hidden)
// and keep links (so a click could navigate the frameless window away).

function renderReply(content: string) {
  const { container } = render(<MarkdownContent content={content} />);
  return container.querySelector('.ai-markdown') as HTMLElement;
}

describe('AI reply rendering', () => {
  it('strips stylesheets a reply could use to hide the approval panel', () => {
    const payloads = [
      '<style>.cli-panel{display:none}</style>done',
      'done<style>.cli-panel{display:none}</style>',
      '<svg><style>.cli-panel{display:none}</style></svg>done',
    ];

    for (const payload of payloads) {
      const out = renderReply(payload);
      expect(out.querySelectorAll('style'), payload).toHaveLength(0);
    }
  });

  it('strips an overlay that would sit on top of the panel', () => {
    const out = renderReply('<div style="position:fixed;inset:0;z-index:999999">press enter to continue</div>');
    expect(out.querySelector('[style]')).toBeNull();
    expect(out.querySelector('[popover]')).toBeNull();
    // The text itself is data the user may need to read; only the styling goes.
    expect(out.textContent).toContain('press enter to continue');
  });

  it('keeps links as links, so the global guard can route them', () => {
    // Sanitizing must not strip the href: the link guard is what stops the
    // window navigating, and it needs the attribute to classify the click.
    const out = renderReply('[docs](https://example.com/x) and [local](LICENSE)');
    expect(out.querySelector('a[href="https://example.com/x"]')).not.toBeNull();
    expect(out.querySelector('a[href="LICENSE"]')).not.toBeNull();
  });

  it('still renders ordinary reply formatting', () => {
    const out = renderReply('## Heading\n\n- [x] done\n\n```bash\nls -la\n```\n\n**bold**');
    expect(out.querySelector('h2')?.textContent).toBe('Heading');
    expect(out.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(out.querySelector('pre code')?.textContent).toContain('ls -la');
    expect(out.querySelector('strong')?.textContent).toBe('bold');
  });
});
