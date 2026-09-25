import DOMPurify from 'dompurify';

// Rendered HTML — Markdown from a server, and the AI assistant's replies — lands
// in the same document as the rest of the application. A stylesheet or an
// overlay smuggled through either of them can therefore restyle or hide
// application UI, the approval panel included, rather than only its own
// content.
//
// This policy is shared on purpose. The document preview and the AI panel used
// to sanitize independently, and the AI panel kept DOMPurify's defaults, which
// allow every vector below. Keeping one list means the two cannot drift apart
// again.
//
// What each rule closes:
//
//   - `<style>` / `style=`: a stylesheet applies to the whole document, and
//     `position:fixed` with a large z-index covers the window without needing a
//     stylesheet at all. DOMPurify's default profile drops a bare `<style>` only
//     when it is the first element; anywhere else it survives.
//   - `<svg><style>`: survives the default profile in every position, and an
//     inline SVG stylesheet still applies document-wide.
//   - `popover` / `popovertarget`: the same overlay trick through the top layer,
//     which paints above every z-index.
//   - `<form>` / `<dialog>`: no legitimate use in rendered content.
//
// `input` is deliberately NOT forbidden: GFM task lists render as
// `<input type="checkbox">`.
export const FORBIDDEN_TAGS = ['style', 'form', 'dialog'];
export const FORBIDDEN_ATTRS = ['style', 'popover', 'popovertarget'];

export type SanitizeExtras = {
  ADD_TAGS?: string[];
  ADD_ATTR?: string[];
};

// Sanitize rendered HTML with the shared policy plus whatever the caller needs.
// Extras can only widen the allow-list; the forbid-list is applied last so a
// caller cannot accidentally re-enable a forbidden tag or attribute.
export function sanitizeRenderedHtml(rawHtml: string, extras: SanitizeExtras = {}): string {
  return DOMPurify.sanitize(rawHtml, {
    ...extras,
    FORBID_TAGS: [...FORBIDDEN_TAGS],
    FORBID_ATTR: [...FORBIDDEN_ATTRS],
  });
}
