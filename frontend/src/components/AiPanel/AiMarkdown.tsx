import { memo, useMemo } from "react";
import { marked } from "marked";
import { sanitizeRenderedHtml } from "../../utils/sanitizeHtml";
marked.setOptions({ breaks: true, gfm: true });
export const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(() => sanitizeRenderedHtml(marked.parse(content) as string), [content]);
  return <div className="ai-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});
