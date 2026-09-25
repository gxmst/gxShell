import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyRenderedLink, useRenderedLinkGuard } from './useRenderedLinkGuard';

const runtimeMocks = vi.hoisted(() => ({ browserOpenURL: vi.fn() }));

vi.mock('../../wailsjs/runtime/runtime', () => ({
  BrowserOpenURL: runtimeMocks.browserOpenURL,
}));

const hosts: HTMLElement[] = [];

// A standalone surface with no handler of its own, which is what the guard
// exists for: rendered HTML that nothing else routes.
function mountHtml(html: string) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  hosts.push(host);
  return host;
}

function Harness({ onBlocked }: { onBlocked: (href: string) => void }) {
  useRenderedLinkGuard(onBlocked);
  return null;
}

// Returns whether the click was left to the WebView to handle.
function click(element: Element) {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return !event.defaultPrevented;
}

afterEach(() => {
  runtimeMocks.browserOpenURL.mockReset();
  for (const host of hosts.splice(0)) host.remove();
});

describe('classifyRenderedLink', () => {
  it('classifies every anchor shape rendered content can produce', () => {
    const host = mountHtml([
      '<a href="https://example.com/x" id="web">web</a>',
      '<a href="mailto:a@b.c" id="mail">mail</a>',
      '<a href="#section" id="frag">frag</a>',
      '<a href="LICENSE" id="rel">rel</a>',
      '<map name="m"><area href="https://example.com/a" id="area"></map>',
      // SVG anchors can carry either form; no CSS attribute selector reaches
      // the namespaced one, which is why it is read directly.
      '<svg><a href="https://example.com/h" id="svgHref"><text>h</text></a></svg>',
      '<svg><a xlink:href="https://example.com/xl" id="svgXlink"><text>x</text></a></svg>',
      '<span id="plain">not a link</span>',
    ].join(''));

    const at = (id: string) => host.querySelector(`#${id}`) as Element;
    expect(classifyRenderedLink(at('web'))).toEqual({ kind: 'external', href: 'https://example.com/x' });
    expect(classifyRenderedLink(at('mail'))).toEqual({ kind: 'external', href: 'mailto:a@b.c' });
    expect(classifyRenderedLink(at('frag'))).toEqual({ kind: 'fragment', href: '#section' });
    expect(classifyRenderedLink(at('rel'))).toEqual({ kind: 'blocked', href: 'LICENSE' });
    expect(classifyRenderedLink(at('area'))).toEqual({ kind: 'external', href: 'https://example.com/a' });
    expect(classifyRenderedLink(at('svgHref'))).toEqual({ kind: 'external', href: 'https://example.com/h' });
    expect(classifyRenderedLink(at('svgXlink'))).toEqual({ kind: 'external', href: 'https://example.com/xl' });
    expect(classifyRenderedLink(at('plain'))).toBeNull();
    expect(classifyRenderedLink(null)).toBeNull();
  });

  it('ignores an anchor with no usable href', () => {
    const host = mountHtml('<a id="bare">bare</a><a href="   " id="blank">blank</a>');
    expect(classifyRenderedLink(host.querySelector('#bare') as Element)).toBeNull();
    expect(classifyRenderedLink(host.querySelector('#blank') as Element)).toBeNull();
  });
});

describe('useRenderedLinkGuard', () => {
  it('routes an external link to the system browser instead of navigating', () => {
    render(<Harness onBlocked={vi.fn()} />);
    const host = mountHtml('<a href="https://example.com/x">web</a>');

    expect(click(host.querySelector('a') as Element)).toBe(false);
    expect(runtimeMocks.browserOpenURL).toHaveBeenCalledWith('https://example.com/x');
  });

  it('blocks a relative link and reports it', () => {
    const onBlocked = vi.fn();
    render(<Harness onBlocked={onBlocked} />);
    const host = mountHtml('<a href="LICENSE">LICENSE</a>');

    expect(click(host.querySelector('a') as Element)).toBe(false);
    expect(runtimeMocks.browserOpenURL).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledWith('LICENSE');
  });

  it('blocks an area and an SVG xlink:href, which had no handler before', () => {
    const onBlocked = vi.fn();
    render(<Harness onBlocked={onBlocked} />);
    const host = mountHtml(
      '<map name="m"><area href="LICENSE" id="area"></map>'
      + '<svg><a xlink:href="https://example.com/x" id="xlink"><text>x</text></a></svg>',
    );

    expect(click(host.querySelector('#area') as Element)).toBe(false);
    expect(click(host.querySelector('#xlink') as Element)).toBe(false);
    expect(onBlocked).toHaveBeenCalledWith('LICENSE');
    expect(runtimeMocks.browserOpenURL).toHaveBeenCalledWith('https://example.com/x');
  });

  it('leaves a click that a component already handled alone', () => {
    const onBlocked = vi.fn();
    render(<Harness onBlocked={onBlocked} />);
    const host = mountHtml('<a href="next.md">next</a>');
    // Stands in for the document viewer, which resolves relative paths itself
    // and needs the click to reach its own handler untouched.
    host.addEventListener('click', (event) => event.preventDefault());

    expect(click(host.querySelector('a') as Element)).toBe(false);
    expect(onBlocked).not.toHaveBeenCalled();
    expect(runtimeMocks.browserOpenURL).not.toHaveBeenCalled();
  });

  it('leaves a click that is not on a link alone', () => {
    const onBlocked = vi.fn();
    render(<Harness onBlocked={onBlocked} />);
    const host = mountHtml('<p id="text">plain text</p>');

    expect(click(host.querySelector('#text') as Element)).toBe(true);
    expect(onBlocked).not.toHaveBeenCalled();
  });
});
