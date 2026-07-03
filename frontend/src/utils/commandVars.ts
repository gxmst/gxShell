// Command templates may contain <name> placeholders, e.g.
// "systemctl status <service>" or "tail -f <logfile>". Before sending such a
// command to a terminal we prompt the user to fill each placeholder.
//
// Syntax: a placeholder is <name> where name is letters, digits, underscore,
// dash, or dot. This deliberately does NOT match shell redirection like
// "cmd < file" or "2>&1" (those have spaces or non-name characters), and it
// does not match "<<EOF" heredocs (two angle brackets). Anything that is not a
// clean single <name> token is left untouched and treated as literal text.

const PLACEHOLDER_RE = /<([A-Za-z0-9_.-]+)>/g;

// extractPlaceholders returns the unique placeholder names in order of first
// appearance. Returns an empty array when the command has none.
export function extractPlaceholders(command: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(command)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

// fillPlaceholders substitutes every <name> with values[name]. A placeholder
// with no provided value is left as-is so a partially filled command is never
// silently corrupted. Every occurrence of a repeated placeholder is replaced.
export function fillPlaceholders(command: string, values: Record<string, string>): string {
  return command.replace(PLACEHOLDER_RE, (whole, name: string) => {
    const value = values[name];
    if (value === undefined || value === "") return whole;
    // Strip CR/LF from the substituted value so a pasted multi-line value cannot
    // silently turn one command into several (each newline would execute).
    return value.replace(/[\r\n]+/g, " ");
  });
}
