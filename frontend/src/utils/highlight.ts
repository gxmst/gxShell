export type HighlightLevel = "off" | "basic" | "full";

export type HighlightMatch = {
  start: number;
  end: number;
  color: string;
};

type HighlightRule = {
  pattern: RegExp;
  color: string;
};

const basicRules: HighlightRule[] = [
  { pattern: /\b(error|fail(ed|ure)?|fatal|panic|refused|denied|invalid|cannot|timed?\s*out)\b/gi, color: "#ff6b6b" },
  { pattern: /\b(warn(ing)?|deprecated|caution)\b/gi, color: "#f6c760" },
  { pattern: /\b(success(fully)?|succeed(ed|s|ing)?|ok|done|complete(d)?|finished|ready|running|online|healthy|active)\b/gi, color: "#51d88a" },
  { pattern: /\b(debug|trace|verbose|info|notice)\b/gi, color: "#94a3b8" },
];

const fullRules: HighlightRule[] = [
  ...basicRules,
  { pattern: /\b([\w.-]+@[\w.-]+)\b/g, color: "#5de4c7" },
  { pattern: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d{1,5})?\b/g, color: "#64d2ff" },
  { pattern: /\b(https?:\/\/[^\s]+)/g, color: "#5de4c7" },
  { pattern: /\b(\/[^\s,:]*\/[^\s,:]*)\b/g, color: "#c792ea" },
  { pattern: /\b(root|admin|sudo|su)\b/g, color: "#ff6b6b" },
  { pattern: /\b(true|false|yes|no|on|off|enable[d]?|disable[d]?)\b/gi, color: "#64d2ff" },
  { pattern: /\b((\d+\.?\d*)\s*(KB|MB|GB|TB|B|ms|s|%|bps))\b/gi, color: "#f6c760" },
  { pattern: /\b(stop(ped|ping)?|start(ing|ed)?|restart(ing|ed)?|reload(ing|ed)?|terminat(ing|ed)?|kill(ed)?)\b/gi, color: "#c792ea" },
  { pattern: /\b(listen(ing)?|connect(ing|ed)?|disconnect(ed)?|bind(ing)?|open(ed)?|close[d]?)\b/gi, color: "#5de4c7" },
  { pattern: /\b(up|down|upgrade|downgrade|install(ing|ed)?|remove[ds]?|delete[ds]?|create[ds]?|modif(ying|ied))\b/gi, color: "#64d2ff" },
  { pattern: /\b(daemon|service|process|thread|pid|signal|port|socket|host|client|server|peer|node)\b/gi, color: "#5de4c7" },
  { pattern: /\b(cpu|mem(ory)?|disk|io|net(work)?|bandwidth|latency|throughput)\b/gi, color: "#c792ea" },
  { pattern: /\b(nginx|apache|mysql|postgres(ql)?|redis|docker|k8s|kubernetes|ssh|http|ftp|tcp|udp|dns|tls|ssl)\b/gi, color: "#64d2ff" },
];

/**
 * Finds display-only highlight ranges. The returned ranges are applied with
 * xterm decorations; this function never inserts bytes into terminal output.
 */
export function findHighlightMatches(text: string, level: HighlightLevel): HighlightMatch[] {
  if (level === "off" || !text.trim()) return [];
  const rules = level === "full" ? fullRules : basicRules;
  const matches: HighlightMatch[] = [];

  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (!matches.some((item) => start < item.end && end > item.start)) {
        matches.push({ start, end, color: rule.color });
      }
      if (match[0].length === 0) rule.pattern.lastIndex += 1;
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}
