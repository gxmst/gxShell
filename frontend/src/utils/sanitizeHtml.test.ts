import { describe, expect, it } from 'vitest';
import { FORBIDDEN_ATTRS, FORBIDDEN_TAGS, sanitizeRenderedHtml } from './sanitizeHtml';

// The document preview and the AI panel both render HTML into the application's
// own document, so anything these vectors let through can restyle or hide
// application UI — the approval panel included — rather than only its own
// content. These assertions are structural (which elements and attributes come
// out) rather than textual, so matching the payload's own text cannot pass by
// accident.

function body(html: string) {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('shared rendered-HTML policy', () => {
  it('strips every stylesheet and overlay vector', () => {
    const cases: [string, string][] = [
      ['leading bare style', '<style>.cli-panel{display:none}</style><p>ok</p>'],
      // DOMPurify's default profile drops a bare <style> only in first
      // position; anywhere else it survives. This is why the tag is forbidden
      // outright instead of being left to the default profile.
      ['trailing bare style', '<p>ok</p><style>.cli-panel{display:none}</style>'],
      ['style inside svg', '<svg><style>.cli-panel{display:none}</style></svg><p>ok</p>'],
      ['inline style attribute', '<div style="position:fixed;inset:0;z-index:999999">cover</div>'],
      ['popover', '<div popover id="p">cover</div>'],
      ['popovertarget', '<button popovertarget="p">cover</button>'],
    ];

    for (const [name, payload] of cases) {
      const out = body(sanitizeRenderedHtml(payload));
      expect(out.querySelectorAll('style'), name).toHaveLength(0);
      for (const element of out.querySelectorAll('*')) {
        expect(element.hasAttribute('style'), `${name} kept style= on <${element.tagName}>`).toBe(false);
        expect(element.hasAttribute('popover'), name).toBe(false);
        expect(element.hasAttribute('popovertarget'), name).toBe(false);
      }
    }
  });

  it('drops form and dialog, which rendered content has no use for', () => {
    const out = body(sanitizeRenderedHtml('<form action="/x"><input name="a"></form><dialog open>d</dialog>'));
    expect(out.querySelectorAll('form')).toHaveLength(0);
    expect(out.querySelectorAll('dialog')).toHaveLength(0);
  });

  it('still renders the Markdown that needs the remaining tags', () => {
    const out = body(sanitizeRenderedHtml('<p>text</p><input type="checkbox" checked disabled><pre><code>ls</code></pre>'));
    // GFM task lists render as a checkbox, so `input` must stay allowed.
    expect(out.querySelector('input[type="checkbox"]')).not.toBeNull();
    expect(out.querySelector('pre > code')?.textContent).toBe('ls');
    expect(out.textContent).toContain('text');
  });

  it('lets a caller widen the allow-list without reopening a forbidden vector', () => {
    const out = body(sanitizeRenderedHtml('<button data-code-copy>x</button><div style="color:red">y</div>', {
      ADD_TAGS: ['button'],
      ADD_ATTR: ['data-code-copy', 'style'],
    }));
    expect(out.querySelector('button[data-code-copy]')).not.toBeNull();
    // `style` is asked for as an extra but the forbid-list is applied last.
    expect(out.querySelector('[style]')).toBeNull();
  });

  it('exposes the policy so a caller cannot silently diverge from it', () => {
    expect(FORBIDDEN_TAGS).toContain('style');
    expect(FORBIDDEN_ATTRS).toContain('style');
  });
});
