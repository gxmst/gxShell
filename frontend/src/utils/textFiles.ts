export const supportedTextExtensions = [
  ".md", ".markdown", ".txt", ".text", ".log",
  ".conf", ".cfg", ".ini", ".env",
  ".json", ".jsonl", ".yaml", ".yml", ".toml", ".xml",
  ".csv", ".tsv",
  ".sh", ".bash", ".zsh", ".fish",
  ".ps1", ".bat", ".cmd", ".sql", ".service",
];

export const supportedDocumentExtensions = [...supportedTextExtensions, ".pdf"];

export type DocumentEditorMode = "plain" | "markdown" | "json" | "jsonl";

export function extensionOf(filePath: string) {
  const name = filePath.split(/[\\/]/).pop() || "";
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

export function isMarkdownPath(filePath: string) {
  const ext = extensionOf(filePath);
  return ext === ".md" || ext === ".markdown";
}

export function isPdfPath(filePath: string) {
  return extensionOf(filePath) === ".pdf";
}

export function isJsonPath(filePath: string) {
  return extensionOf(filePath) === ".json";
}

export function isJsonLinesPath(filePath: string) {
  return extensionOf(filePath) === ".jsonl";
}

export function documentEditorMode(filePath: string): DocumentEditorMode {
  if (isMarkdownPath(filePath)) return "markdown";
  if (isJsonPath(filePath)) return "json";
  if (isJsonLinesPath(filePath)) return "jsonl";
  return "plain";
}

export function isSupportedTextPath(filePath: string) {
  return supportedTextExtensions.includes(extensionOf(filePath));
}

export function isSupportedDocumentPath(filePath: string) {
  return supportedDocumentExtensions.includes(extensionOf(filePath));
}
