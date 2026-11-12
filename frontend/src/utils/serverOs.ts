import { types } from "../../wailsjs/go/models";

export type ServerOsType =
  | "ubuntu"
  | "debian"
  | "centos"
  | "redhat"
  | "rocky"
  | "alpine"
  | "arch"
  | "windows"
  | "macos"
  | "docker"
  | "freebsd"
  | "linux"
  | "server";

const OS_STORAGE_PREFIX = "gx_detected_os_";

export function getStoredServerOs(profileId: string): ServerOsType | null {
  if (!profileId) return null;
  try {
    if (typeof window !== "undefined" && window.localStorage && typeof window.localStorage.getItem === "function") {
      const val = window.localStorage.getItem(OS_STORAGE_PREFIX + profileId);
      if (val && isValidOsType(val)) return val;
    }
  } catch {
    // localStorage not available
  }
  return null;
}

export function saveStoredServerOs(profileId: string, os: ServerOsType): void {
  if (!profileId || !isValidOsType(os)) return;
  try {
    if (typeof window !== "undefined" && window.localStorage && typeof window.localStorage.setItem === "function") {
      window.localStorage.setItem(OS_STORAGE_PREFIX + profileId, os);
    }
  } catch {
    // ignore
  }
}

export function detectOsFromText(text: string): ServerOsType | null {
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes("debian") || lower.includes("+deb1") || lower.includes("deb12") || lower.includes("deb11") || lower.includes("deb13") || lower.includes("deb10")) {
    return "debian";
  }
  if (lower.includes("ubuntu")) return "ubuntu";
  if (lower.includes("rocky") || lower.includes("almalinux") || lower.includes("alma linux")) return "rocky";
  if (lower.includes("centos")) return "centos";
  if (lower.includes("alpine")) return "alpine";
  if (lower.includes("arch linux") || lower.includes("archlinux")) return "arch";
  if (lower.includes("fedora") || lower.includes("red hat") || lower.includes("rhel")) return "redhat";
  if (lower.includes("freebsd") || lower.includes("openbsd")) return "freebsd";
  if (lower.includes("darwin") || lower.includes("macos")) return "macos";
  if (lower.includes("windows") || lower.includes("microsoft") || lower.includes("winserver")) return "windows";
  if (lower.includes("docker") || lower.includes("containerd")) return "docker";
  if (lower.includes("linux")) return "linux";
  return null;
}

export function detectServerOs(profile: types.Profile, runtimeOs?: ServerOsType): ServerOsType {
  // 1. Explicit tag: "os:ubuntu", "os:centos", etc.
  if (profile.tags && profile.tags.length > 0) {
    for (const tag of profile.tags) {
      const lower = tag.toLowerCase().trim();
      if (lower.startsWith("os:")) {
        const val = lower.slice(3).trim() as ServerOsType;
        if (isValidOsType(val)) return val;
      }
      if (lower === "ubuntu") return "ubuntu";
      if (lower === "debian") return "debian";
      if (lower === "centos") return "centos";
      if (lower === "redhat" || lower === "rhel" || lower === "fedora") return "redhat";
      if (lower === "rocky" || lower === "alma" || lower === "almalinux") return "rocky";
      if (lower === "alpine") return "alpine";
      if (lower === "arch" || lower === "archlinux") return "arch";
      if (lower === "windows" || lower === "win") return "windows";
      if (lower === "macos" || lower === "darwin" || lower === "apple") return "macos";
      if (lower === "docker" || lower === "container") return "docker";
      if (lower === "freebsd" || lower === "bsd") return "freebsd";
      if (lower === "linux") return "linux";
    }
  }

  // 2. Runtime detected OS passed in from active session / monitor
  if (runtimeOs && isValidOsType(runtimeOs) && runtimeOs !== "server") {
    return runtimeOs;
  }

  // 3. Previously detected and cached OS in localStorage
  if (profile.id) {
    const cached = getStoredServerOs(profile.id);
    if (cached && cached !== "server") return cached;
  }

  // 4. Scan name, description, host for common OS keywords
  const text = `${profile.name || ""} ${profile.description || ""} ${profile.host || ""}`.toLowerCase();
  const detected = detectOsFromText(text);
  if (detected) return detected;

  return "server";
}

export function isValidOsType(val: string | undefined): val is ServerOsType {
  return !!val && [
    "ubuntu", "debian", "centos", "redhat", "rocky", "alpine",
    "arch", "windows", "macos", "docker", "freebsd", "linux", "server",
  ].includes(val);
}
