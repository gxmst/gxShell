/** Single-quote a path for bash/zsh/sh. Safe for `cd <path>`. */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[\w@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Normalize remote path segments; keeps leading slash for absolute paths. */
export function joinRemotePath(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .join("/")
    .replace(/\/+/g, "/");
  if (joined === "") return ".";
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

export function parentRemotePath(path: string): string {
  if (!path || path === "." || path === "/") return path === "/" ? "/" : ".";
  const clean = path.replace(/\/+$/, "") || "/";
  if (clean === "/") return "/";
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return clean.startsWith("/") ? "/" : ".";
  return clean.slice(0, idx) || "/";
}

export function pathSegments(path: string): { label: string; path: string }[] {
  if (!path || path === ".") return [{ label: ".", path: "." }];
  const absolute = path.startsWith("/");
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length === 0) return [{ label: "/", path: "/" }];
  const out: { label: string; path: string }[] = [];
  if (absolute) out.push({ label: "/", path: "/" });
  let acc = "";
  if (absolute) acc = "/";
  for (const part of parts) {
    acc = joinRemotePath(acc, part);
    out.push({ label: part, path: acc });
  }
  return out;
}
