export type MermaidTheme = 'default' | 'dark';
export type MermaidDrawing = { svg: string; width: number; height: number };

let modulePromise: Promise<typeof import('mermaid')['default']> | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let sequence = 0;

function getMermaid() {
  if (!modulePromise) {
    modulePromise = import('mermaid').then(({ default: mermaid }) => mermaid).catch((error) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

export function mermaidThemeFor(element: Element | null): MermaidTheme {
  const name = element?.closest('[data-theme]')?.getAttribute('data-theme');
  return ['Dark', 'Deep Blue', 'Ember Terminal', 'Twilight Amber'].includes(name || '') ? 'dark' : 'default';
}

export function renderMermaid(source: string, theme: MermaidTheme, signal: AbortSignal): Promise<MermaidDrawing | null> {
  // initialize() changes global Mermaid state. Keep configuration and rendering
  // in the same queue, including when several documents render concurrently.
  const operation = renderQueue.then(async () => {
    if (signal.aborted) return null;
    const [mermaid, renderer] = await Promise.all([getMermaid(), import('./markdownRenderer')]);
    if (signal.aborted) return null;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme,
      // Current Mermaid/DOMPurify combinations can discard foreignObject
      // contents inside Mermaid itself. Native SVG labels also scale cleanly.
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'dompurifyConfig', 'htmlLabels'],
    });
    // A private, measurable container prevents parse-error SVGs or abandoned
    // renders from leaking into the app. display:none would break text sizing.
    const host = document.createElement('div');
    host.className = 'md-mermaid-measure';
    host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1024px;visibility:hidden;pointer-events:none';
    host.setAttribute('aria-hidden', 'true');
    document.body.append(host);
    try {
      const result = await mermaid.render(`gx-md-mermaid-${++sequence}`, source, host);
      if (signal.aborted) return null;
      const svg = renderer.sanitizeMermaidSVG(result.svg);
      const parsed = document.createElement('div');
      parsed.innerHTML = svg;
      const element = parsed.querySelector('svg');
      if (!element) throw new Error('Mermaid produced an empty diagram');
      const viewBox = (element.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
      const width = viewBox[2] || Number.parseFloat(element.getAttribute('width') || '');
      const height = viewBox[3] || Number.parseFloat(element.getAttribute('height') || '');
      return {
        svg,
        width: Number.isFinite(width) && width > 0 ? width : 800,
        height: Number.isFinite(height) && height > 0 ? height : 600,
      };
    } finally {
      host.remove();
    }
  });
  // A malformed diagram must not prevent later diagrams (or retries) rendering.
  renderQueue = operation.catch(() => undefined);
  return operation;
}
