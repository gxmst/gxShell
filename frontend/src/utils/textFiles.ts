export const supportedTextExtensions = [
  ".md", ".markdown", ".txt", ".text", ".log",
  ".conf", ".cfg", ".ini", ".env",
  ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml",
  ".csv", ".tsv",
  ".sh", ".bash", ".zsh", ".fish",
  ".ps1", ".bat", ".cmd", ".sql", ".service",
];

export function extensionOf(filePath: string) {
  const name = filePath.split(/[\\/]/).pop() || "";
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

export function isMarkdownPath(filePath: string) {
  const ext = extensionOf(filePath);
  return ext === ".md" || ext === ".markdown";
}

export function isSupportedTextPath(filePath: string) {
  return supportedTextExtensions.includes(extensionOf(filePath));
}
