import { describe, expect, it } from 'vitest';
import { findHeadingElement, headingDomId, headingSlugOf } from './markdownHeadings';

function host(html: string) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

describe('markdownHeadings', () => {
  it('prefixes a slug so it cannot clobber a DOM property', () => {
    expect(headingDomId('scripts')).toBe('md-scripts');
    expect(headingDomId('intro')).toBe('md-intro');
  });

  it('resolves a slug through data-md-heading', () => {
    const root = host('<h2 id="md-scripts" data-md-heading="scripts">Scripts</h2>');
    expect(findHeadingElement(root, 'scripts')).toBe(root.querySelector('h2'));
  });

  it('falls back to the prefixed id and then to the bare id', () => {
    const prefixed = host('<h2 id="md-intro">Intro</h2>');
    expect(findHeadingElement(prefixed, 'intro')?.id).toBe('md-intro');

    // Markup the renderer did not produce: a hand-written heading that kept
    // its id, or HTML a caller injected directly.
    const bare = host('<h2 id="target">Target</h2>');
    expect(findHeadingElement(bare, 'target')?.id).toBe('target');
  });

  it('resolves slugs a selector would choke on', () => {
    const root = host('<h2 id="md-a-b" data-md-heading="a b">spaced</h2><h2 data-md-heading="q&quot;z">quoted</h2>');
    expect(findHeadingElement(root, 'a b')?.textContent).toBe('spaced');
    expect(findHeadingElement(root, 'q"z')?.textContent).toBe('quoted');
  });

  it('reports the slug an element carries, not its prefixed id', () => {
    const root = host('<h2 id="md-scripts" data-md-heading="scripts">s</h2><h3 id="plain">p</h3>');
    const [first, second] = Array.from(root.querySelectorAll<HTMLElement>('h2, h3'));
    expect(headingSlugOf(first)).toBe('scripts');
    expect(headingSlugOf(second)).toBe('plain');
  });

  it('returns null for a missing root, an empty slug, or no match', () => {
    expect(findHeadingElement(null, 'scripts')).toBeNull();
    expect(findHeadingElement(host('<p>x</p>'), '')).toBeNull();
    expect(findHeadingElement(host('<p>x</p>'), 'missing')).toBeNull();
  });
});
