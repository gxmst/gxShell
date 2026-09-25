import { useEffect } from 'react';
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime';

// The window is frameless, so a link the WebView follows replaces the whole
// application with no way back and discards every unsaved draft.
//
// Rendered HTML appears in several places — the Markdown preview, the AI
// assistant's replies, tool output — and each of them used to need its own click
// handler. Missing one meant a link could still navigate the app away, which is
// exactly what happened to the AI panel.
//
// This guard is the single net underneath all of them. It listens in the bubble
// phase, so it runs after the application's own handlers: a component that can
// route a link properly (the document viewer resolves relative paths against the
// file it is showing) calls preventDefault and this stays out of the way.
// Anything still unhandled is resolved here.

export type RenderedLink =
  | { kind: 'external'; href: string }
  | { kind: 'fragment'; href: string }
  | { kind: 'blocked'; href: string };

function findHref(target: Element): string | null {
  const anchor = target.closest('a[href], area[href]');
  if (anchor) return anchor.getAttribute('href');
  // An SVG <a> may carry `href` or the namespaced `xlink:href`. No CSS
  // attribute selector reaches the namespaced form, so it is read directly
  // rather than being left to navigate the window.
  const svgAnchor = target.closest('a');
  if (svgAnchor) return svgAnchor.getAttribute('href') || svgAnchor.getAttribute('xlink:href');
  return null;
}

// Classify a click that landed on rendered HTML. Returns null when the click is
// not on a link at all, so the caller leaves it alone.
export function classifyRenderedLink(target: Element | null): RenderedLink | null {
  if (!target) return null;
  const href = (findHref(target) || '').trim();
  if (href === '') return null;
  if (href.startsWith('#')) return { kind: 'fragment', href };
  if (/^(https?:|mailto:)/i.test(href)) return { kind: 'external', href };
  return { kind: 'blocked', href };
}

// onBlocked is called for a link that has nowhere safe to go. It is kept in a
// ref-like dependency so callers can pass an inline function without
// re-registering the listener on every render.
export function useRenderedLinkGuard(onBlocked: (href: string) => void) {
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      // A component already handled this click; it had the context to do it
      // properly, so it wins.
      if (event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = classifyRenderedLink(target);
      if (!link) return;
      // Whatever the link is, it must not reach the WebView. A fragment with no
      // handler stays a no-op rather than an error: the document viewer scrolls
      // its own, and it handled the click before this ran.
      event.preventDefault();
      if (link.kind === 'external') BrowserOpenURL(link.href);
      else if (link.kind === 'blocked') onBlocked(link.href);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [onBlocked]);
}
