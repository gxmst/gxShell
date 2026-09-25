// Heading anchors are addressed by the slug derived from the heading text
// (`## Scripts` -> `scripts`), because that is what both the outline and a
// hand-written `[jump](#scripts)` fragment carry.
//
// The DOM id cannot be that bare slug. Rendered Markdown is sanitized, and
// DOMPurify's SANITIZE_DOM guard drops any id whose value is already a property
// of `document` or of a form — `scripts`, `title`, `name`, `body`, `location`,
// `images`, … — because such an id lets markup clobber those properties. A
// heading called "Scripts" would therefore lose its id, and both the outline
// and the in-page fragment would scroll nowhere. Prefixing keeps every slug
// addressable while making a collision impossible: no property of `document`
// starts with `md-`.
//
// This lives outside markdownRenderer.ts on purpose. The renderer is imported
// lazily so `marked` and highlight.js stay out of the initial bundle, while
// the viewer needs this helper on the very first click.

const HEADING_ID_PREFIX = 'md-';

export function headingDomId(slug: string): string {
  return `${HEADING_ID_PREFIX}${slug}`;
}

// CSS.escape produces identifier-safe escaping, which is also valid inside a
// quoted attribute-selector string (both forms use backslash escapes).
function cssEscape(value: string) {
  return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}

// Resolve a slug to its heading element.
//
// `data-md-heading` is the authoritative copy of the slug — an attribute cannot
// be dropped for clobbering — so it is tried first. The prefixed id covers
// headings whose `data-md-heading` was stripped by something else, and the bare
// slug covers markup the renderer did not produce (injected HTML, hand-written
// headings that kept their id, and the `id="target"` a test may supply).
export function findHeadingElement(root: ParentNode | null | undefined, slug: string): HTMLElement | null {
  if (!root || !slug) return null;
  const bySlug = root.querySelector<HTMLElement>(`[data-md-heading="${cssEscape(slug)}"]`);
  if (bySlug) return bySlug;
  return root.querySelector<HTMLElement>(`#${cssEscape(headingDomId(slug))}`)
    ?? root.querySelector<HTMLElement>(`#${cssEscape(slug)}`);
}

// The slug an element carries, for matching an outline entry back to it. The
// active-heading tracker reads this rather than `element.id`, which is prefixed.
export function headingSlugOf(element: HTMLElement): string {
  return element.dataset.mdHeading || element.id;
}
