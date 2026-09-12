export const supportedTextExtensions = [
  ".md", ".markdown", ".txt", ".text", ".log",
  ".conf", ".cfg", ".ini", ".env",
  ".json", ".jsonc", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".xml",
  ".csv", ".tsv",
  ".sh", ".bash", ".zsh", ".fish",
  ".ps1", ".bat", ".cmd", ".sql", ".service",
  ".py", ".js", ".mjs", ".cjs", ".ts", ".jsx", ".tsx", ".go",
  ".html", ".htm", ".css",
];

export const supportedTextFileNames = ["dockerfile", "containerfile", "makefile", "gnumakefile", "justfile", ".gitignore", ".gitattributes", ".dockerignore", ".editorconfig", ".bashrc", ".zshrc", ".profile"];

export const supportedDocumentExtensions = [...supportedTextExtensions, ".pdf"];

export type DocumentEditorMode = "plain" | "markdown" | "json" | "jsonc" | "jsonl";

export function documentDirectory(filePath: string) {
  const path = filePath.replace(/\\/g, "/");
  const slash = path.lastIndexOf("/");
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  if (slash === 2 && path[1] === ":") return path.slice(0, 3);
  return path.slice(0, slash);
}

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
  return [".jsonl", ".ndjson"].includes(extensionOf(filePath));
}

export function documentEditorMode(filePath: string): DocumentEditorMode {
  if (isMarkdownPath(filePath)) return "markdown";
  if (isJsonPath(filePath)) return "json";
  if (extensionOf(filePath) === ".jsonc") return "jsonc";
  if (isJsonLinesPath(filePath)) return "jsonl";
  return "plain";
}

export function isSupportedTextPath(filePath: string) {
  const name = (filePath.split(/[\\/]/).pop() || "").toLowerCase();
  return supportedTextExtensions.includes(extensionOf(filePath)) || supportedTextFileNames.includes(name)
    || /^(?:\.env|dockerfile|containerfile)\..+$/.test(name);
}

export function isSupportedDocumentPath(filePath: string) {
  return isSupportedTextPath(filePath) || isPdfPath(filePath);
}
