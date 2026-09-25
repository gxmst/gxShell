import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MarkdownViewer from './MarkdownViewer';
import { memoryStorage } from '../../test/memoryStorage';

// The window is frameless, so a link the WebView follows replaces the whole app
// with no way back and discards unsaved drafts. These tests pin the rule: the
// only clicks that may reach the WebView are the ones we deliberately route.

const appMocks = vi.hoisted(() => ({
  readLocalFile: vi.fn(),
  resolveLocalMarkdownLink: vi.fn(),
}));

const runtimeMocks = vi.hoisted(() => ({ browserOpenURL: vi.fn() }));

const rendererMocks = vi.hoisted(() => ({ buildMarkdown: vi.fn() }));

vi.mock('../../../wailsjs/go/app/App', () => ({
  // The viewer loads a document together with the version it has to send back
  // when saving; these tests are about the text.
  ReadLocalFile: async (path: string) => ({ content: await appMocks.readLocalFile(path), version: 'v1' }),
  ReadLocalMarkdownResourceDataURL: vi.fn(),
  ReadRemoteTextFile: vi.fn(),
  ReadRemoteMarkdownResourceDataURL: vi.fn(),
  ResolveLocalMarkdownLink: appMocks.resolveLocalMarkdownLink,
  ResolveRemoteMarkdownLink: vi.fn(),
  WriteLocalFile: vi.fn(async () => ({ saved: true, conflict: false, version: 'v1' })),
  WriteRemoteTextFile: vi.fn(async () => ({ saved: true, conflict: false, version: 'v1' })),
}));

vi.mock('../../../wailsjs/runtime/runtime', () => ({
  BrowserOpenURL: runtimeMocks.browserOpenURL,
}));

vi.mock('./markdownRenderer', () => ({
  buildMarkdown: rendererMocks.buildMarkdown,
  sanitizeMermaidSVG: (svg: string) => svg,
}));

// Returns whether the click was left to the WebView to handle.
function click(element: Element) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return !event.defaultPrevented;
}

async function renderWithHtml(html: string, onNotify = vi.fn()) {
  rendererMocks.buildMarkdown.mockReturnValue({ html, toc: [] });
  appMocks.readLocalFile.mockResolvedValue('source');
  const { container } = render(
    <MarkdownViewer active filePath={'C:\\docs\\readme.md'} onClose={vi.fn()} onNotify={onNotify} />,
  );
  await waitFor(() => expect(container.querySelector('.markdown-body, [data-md-heading]') ?? container.querySelector('.md-preview, main, div')).toBeTruthy());
  return { container, onNotify };
}

describe('MarkdownViewer link clicks', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    appMocks.readLocalFile.mockReset();
    appMocks.resolveLocalMarkdownLink.mockReset();
    runtimeMocks.browserOpenURL.mockReset();
    rendererMocks.buildMarkdown.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('does not let a relative link to a non-Markdown file navigate the app away', async () => {
    const { container, onNotify } = await renderWithHtml(
      '<p><a href="LICENSE">LICENSE</a><a href="config.example.yaml">config</a></p>',
    );
    const links = await waitFor(() => {
      const found = container.querySelectorAll('a[href="LICENSE"], a[href="config.example.yaml"]');
      expect(found.length).toBe(2);
      return found;
    });

    for (const link of Array.from(links)) {
      expect(click(link), `${link.getAttribute('href')} was left to the WebView`).toBe(false);
    }
    expect(onNotify).toHaveBeenCalledTimes(2);
  });

  it('hands http and mailto links to the system browser instead of navigating', async () => {
    const { container } = await renderWithHtml(
      '<p><a href="https://example.com/x">web</a><a href="mailto:a@b.c">mail</a></p>',
    );
    const web = await waitFor(() => {
      const found = container.querySelector('a[href="https://example.com/x"]');
      expect(found).not.toBeNull();
      return found!;
    });

    expect(click(web)).toBe(false);
    expect(runtimeMocks.browserOpenURL).toHaveBeenCalledWith('https://example.com/x');

    expect(click(container.querySelector('a[href="mailto:a@b.c"]')!)).toBe(false);
    expect(runtimeMocks.browserOpenURL).toHaveBeenCalledWith('mailto:a@b.c');
  });

  it('still opens a Markdown link through the resolver', async () => {
    const onOpenMarkdownFile = vi.fn();
    rendererMocks.buildMarkdown.mockReturnValue({
      html: '<p><a href="#" data-md-link="next.md">Next</a></p>',
      toc: [],
    });
    appMocks.readLocalFile.mockResolvedValue('source');
    appMocks.resolveLocalMarkdownLink.mockResolvedValue('C:\\docs\\next.md');
    const { container } = render(
      <MarkdownViewer active filePath={'C:\\docs\\readme.md'} onClose={vi.fn()} onOpenMarkdownFile={onOpenMarkdownFile} />,
    );

    const link = await waitFor(() => {
      const found = container.querySelector('a[data-md-link]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(click(link)).toBe(false);
    await waitFor(() => expect(onOpenMarkdownFile).toHaveBeenCalledWith({ source: 'local', path: 'C:\\docs\\next.md' }));
  });

  it('scrolls to an in-page fragment without navigating', async () => {
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    try {
      const { container } = await renderWithHtml(
        '<h2 id="target">Target</h2><p><a href="#target">jump</a></p>',
      );
      const link = await waitFor(() => {
        const found = container.querySelector('a[href="#target"]');
        expect(found).not.toBeNull();
        return found!;
      });
      expect(click(link)).toBe(false);
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
    }
  });

  it('scrolls to a heading whose slug would clobber a DOM property', async () => {
    // `## Scripts` is rendered with `id="md-scripts"` because DOMPurify drops a
    // bare `id="scripts"`; the plain slug survives in data-md-heading. Both the
    // heading's own anchor and a hand-written `[x](#scripts)` link address the
    // heading by slug, so the click has to resolve through that attribute.
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) { scrolled.push(this); };
    try {
      const { container } = await renderWithHtml(
        '<h2 id="md-scripts" data-md-heading="scripts"><a class="md-heading-anchor" href="#scripts">#</a>Scripts</h2><p><a href="#scripts">jump</a></p>',
      );
      const heading = container.querySelector('h2')!;
      const link = await waitFor(() => {
        const found = container.querySelector('p a[href="#scripts"]');
        expect(found).not.toBeNull();
        return found!;
      });
      expect(click(link)).toBe(false);
      expect(scrolled).toContain(heading);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('does not navigate even when a fragment has no matching element', async () => {
    // Previously this branch returned without preventing the default, so the
    // WebView followed the href and the app was replaced by the anchor URL.
    const { container } = await renderWithHtml('<p><a href="#missing">jump</a></p>');
    const link = await waitFor(() => {
      const found = container.querySelector('a[href="#missing"]');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(click(link)).toBe(false);
  });

  it('leaves clicks that are not on a link alone', async () => {
    const { container } = await renderWithHtml('<p><span id="plain">text</span></p>');
    const plain = await waitFor(() => {
      const found = container.querySelector('#plain');
      expect(found).not.toBeNull();
      return found!;
    });
    expect(click(plain)).toBe(true);
  });
});
