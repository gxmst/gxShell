export type TerminalDirectory = {
  path: string;
  host?: string;
};

// OSC 7 payloads follow file://host/path. Reject control characters and other
// schemes; prompt scraping is deliberately not used as a fallback.
export function parseOsc7Directory(payload: string): TerminalDirectory | null {
  if (!payload || /[\u0000-\u001f\u007f]/.test(payload)) return null;
  let url: URL;
  try {
    url = new URL(payload);
  } catch {
    return null;
  }
  if (url.protocol !== "file:") return null;

  let directory: string;
  try {
    directory = decodeURIComponent(url.pathname || "/");
  } catch {
    return null;
  }
  // WHATWG URLs retain a leading slash for file:///C:/...; the shell-facing
  // Windows path is C:/..., while POSIX roots keep their slash.
  if (/^\/[a-zA-Z]:\//.test(directory)) directory = directory.slice(1);
  if (!directory || /[\u0000-\u001f\u007f]/.test(directory)) return null;
  return { path: directory, host: url.hostname || undefined };
}
