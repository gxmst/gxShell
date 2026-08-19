import type { CliRiskSpan } from "../../types";

export type RiskTextPart = {
  text: string;
  className?: string;
  note?: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Backend span offsets are UTF-8 byte offsets. Decode byte slices rather than
// using String.slice so Chinese paths and other non-ASCII text stay aligned.
export function splitRiskText(command: string, spans: CliRiskSpan[]): RiskTextPart[] {
  const bytes = encoder.encode(command);
  const ordered = [...spans]
    .filter((span) => span.start >= 0 && span.end > span.start && span.end <= bytes.length)
    .sort((left, right) => left.start - right.start);
  const parts: RiskTextPart[] = [];
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    if (span.start > cursor) parts.push({ text: decoder.decode(bytes.slice(cursor, span.start)) });
    parts.push({
      text: decoder.decode(bytes.slice(span.start, span.end)),
      className: `cli-risk-${span.class}`,
      note: span.note,
    });
    cursor = span.end;
  }
  if (cursor < bytes.length) parts.push({ text: decoder.decode(bytes.slice(cursor)) });
  return parts.length ? parts : [{ text: command }];
}
