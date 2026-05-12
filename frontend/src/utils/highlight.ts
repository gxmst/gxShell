type HighlightRule = { pattern: RegExp; color: number; bold?: boolean };

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  redBg: "\x1b[41m",
  greenBg: "\x1b[42m",
};

export type HighlightLevel = "off" | "basic" | "full";

const basicRules: HighlightRule[] = [
  { pattern: /\b(error|fail(ed|ure)?|fatal|panic|refused|denied|invalid|cannot|timed?\s*out)\b/gi, color: 31 }, 
  { pattern: /\b(warn(ing)?|deprecated|caution)\b/gi, color: 33 },
  { pattern: /\b(success(fully)?|ok|done|complete(d)?|finished|ready|running|online|healthy|active)\b/gi, color: 32 },
  { pattern: /\b(debug|trace|verbose|info|notice)\b/gi, color: 90 },
];

const fullRules: HighlightRule[] = [
  ...basicRules,
  { pattern: /\b([\w.-]+@[\w.-]+)/g, color: 36 },
  { pattern: /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(:\d{1,5})?\b/g, color: 34 },
  { pattern: /\b(https?:\/\/[^\s]+)/g, color: 36 },
  { pattern: /\b(\/[^\s,:]*\/[^\s,:]*)\b/g, color: 35 },
  { pattern: /\b(root|admin|sudo|su)\b/g, color: 31, bold: true },
  { pattern: /\b(true|false|yes|no|on|off|enable[d]?|disable[d]?)\b/gi, color: 34 },
  { pattern: /\b((\d+\.?\d*)\s*(KB|MB|GB|TB|B|ms|s|%|bps))\b/gi, color: 33 },
  { pattern: /\b(stop(ped|ping)?|start(ing|ed)?|restart(ing|ed)?|reload(ing|ed)?|terminat(ing|ed)?|kill(ed)?)\b/gi, color: 35 },
  { pattern: /\b(listen(ing)?|connect(ing|ed)?|disconnect(ed)?|bind(ing)?|open(ed)?|close[d]?)\b/gi, color: 36 },
  { pattern: /\b(up|down|upgrade|downgrade|install(ing|ed)?|remove[ds]?|delete[ds]?|create[ds]?|modif(ying|ied))\b/gi, color: 34 },
  { pattern: /"([^"]+)"/g, color: 32 },
  { pattern: /'([^']+)'/g, color: 33 },
  { pattern: /\b(daemon|service|process|thread|pid|signal|port|socket|host|client|server|peer|node)\b/gi, color: 36 },
  { pattern: /\b(cpu|mem(ory)?|disk|io|net(work)?|bandwidth|latency|throughput)\b/gi, color: 35 },
  { pattern: /\b(nginx|apache|mysql|postgres(ql)?|redis|docker|k8s|kubernetes|ssh|http|ftp|tcp|udp|dns|tls|ssl)\b/gi, color: 34 },
  { pattern: /(?:^|\s)(#\s.*)/g, color: 90 },
  { pattern: /\[([^\]]+)\]/g, color: 90 },
];

function colorCode(color: number, bold?: boolean) {
  const b = bold ? "\x1b[1m" : "";
  return `${b}\x1b[${color}m`;
}

function highlightLine(line: string, level: HighlightLevel): string {
  if (level === "off" || line.includes("\x1b")) return line;
  const rules = level === "full" ? fullRules : basicRules;
  let result = line;
  const applied = new Set<string>();
  for (const rule of rules) {
    result = result.replace(rule.pattern, (match, ..._args) => {
      const key = `${match}|${rule.pattern.source}`;
      if (applied.has(key)) return match;
      applied.add(key);
      return `${colorCode(rule.color, rule.bold)}${match}${ansi.reset}`;
    });
  }
  return result;
}

export function highlight(data: string, level: HighlightLevel): string {
  if (level === "off") return data;
  const lines = data.split("\n");
  for (let i = 0; i < lines.length; i++) {
    lines[i] = highlightLine(lines[i], level);
  }
  return lines.join("\n");
}

export function highlightStream(data: string, level: HighlightLevel, buffer: { current: string }): string {     
  if (level === "off") return data;
  buffer.current += data;
  if (!buffer.current.includes("\n") && buffer.current.length < 2048) {
    return data;
  }
  const result = highlight(buffer.current, level);
  buffer.current = "";
  return result;
}
