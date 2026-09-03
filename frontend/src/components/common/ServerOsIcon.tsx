import type { CSSProperties } from "react";
import { Server } from "lucide-react";
import { types } from "../../../wailsjs/go/models";

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

function isValidOsType(val: string): val is ServerOsType {
  return [
    "ubuntu", "debian", "centos", "redhat", "rocky", "alpine",
    "arch", "windows", "macos", "docker", "freebsd", "linux", "server",
  ].includes(val);
}

export function ServerOsIcon({ os, size = 14, style }: { os: ServerOsType; size?: number; style?: CSSProperties }) {
  const iconProps = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    style,
  };

  switch (os) {
    case "ubuntu":
      return (
        <svg {...iconProps}>
          <circle cx="12" cy="12" r="9.2" stroke="#E95420" strokeWidth="2.2" fill="none" opacity="0.9" />
          <circle cx="12" cy="12" r="3.8" stroke="#E95420" strokeWidth="1.6" fill="none" />
          <circle cx="17.2" cy="8.2" r="1.8" fill="#E95420" />
          <circle cx="17.2" cy="15.8" r="1.8" fill="#E95420" />
          <circle cx="5.8" cy="12" r="1.8" fill="#E95420" />
        </svg>
      );

    case "debian":
      return (
        <svg {...iconProps}>
          <path
            d="M13.8 4.5c3.2.3 5.7 2.5 6.1 5.6.5 3.3-1.1 6.3-4 7.8-2.7 1.4-5.8 1-8-0.8-2-1.6-2.8-4.3-2-6.7.7-2.2 2.6-3.7 4.9-4.1 2-.3 3.8.7 4.7 2.4.7 1.5.3 3.3-1 4.3-1.1 1-2.7 1-3.6 0-.7-.7-.8-1.8-.2-2.6.4-.6 1.1-.7 1.7-.3"
            stroke="#D70A53"
            strokeWidth="2.2"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      );

    case "centos":
      return (
        <svg {...iconProps}>
          <path d="M12 3.5l4 4.5h-8z" fill="#FFA500" />
          <path d="M20.5 12l-4.5 4v-8z" fill="#22B573" />
          <path d="M12 20.5l-4-4.5h8z" fill="#93227F" />
          <path d="M3.5 12l4.5-4v8z" fill="#262577" />
          <circle cx="12" cy="12" r="2.2" fill="currentColor" opacity="0.8" />
        </svg>
      );

    case "redhat":
      return (
        <svg {...iconProps}>
          <path
            d="M4 14.5c2.5 0 4.5-2 8-2s5.5 2 8 2c-1-3.5-3.5-7-8-7s-7 3.5-8 7z"
            fill="#EE0000"
          />
          <ellipse cx="12" cy="15.5" rx="8" ry="2" fill="#EE0000" opacity="0.85" />
          <path d="M7.5 15.2c1.2 1.6 7.8 1.6 9 0" stroke="#ffffff" strokeWidth="1" />
        </svg>
      );

    case "rocky":
      return (
        <svg {...iconProps}>
          <path d="M12 4.5l7 13.5H5z" fill="#10B981" opacity="0.9" />
          <path d="M12 4.5l2.5 13.5h-5z" fill="#047857" />
          <path d="M15.5 11l3.5 7h-7z" fill="#065F46" />
        </svg>
      );

    case "alpine":
      return (
        <svg {...iconProps}>
          <path d="M5.5 18.5l5.5-11 5.5 11z" fill="#0D597F" opacity="0.85" />
          <path d="M13 18.5l4-8 4 8z" fill="#38BDF8" opacity="0.9" />
        </svg>
      );

    case "arch":
      return (
        <svg {...iconProps}>
          <path
            d="M12 4.5c-1.8 3.5-5 10.5-8 14.5 3.5-1.2 5.8-2 8-4.6 2.2 2.6 4.5 3.4 8 4.6-3-4-6.2-11-8-14.5z"
            fill="#1793D1"
          />
        </svg>
      );

    case "windows":
      return (
        <svg {...iconProps}>
          <path d="M4 6.2l6-.8v5.6H4V6.2zm7.2-.9L20 4v7H11.2V5.3zM4 12.2h6v5.6l-6-.8v-4.8zm7.2 0H20v7l-8.8-1.3v-5.7z" fill="#0078D4" />
        </svg>
      );

    case "macos":
      return (
        <svg {...iconProps}>
          <path
            d="M14.8 6.5c.6-.7 1-1.6.9-2.6-.9 0-1.9.6-2.5 1.3-.5.6-.9 1.5-.8 2.5 1 .1 1.9-.5 2.4-1.2zm1.6 4.9c-.1-1.7 1.4-2.5 1.5-2.6-.8-1.2-2.1-1.3-2.5-1.4-1.1-.1-2.2.7-2.8.7-.5 0-1.4-.7-2.3-.7-1.2 0-2.3.7-2.9 1.8-1.3 2.2-.3 5.4.9 7.2.6.9 1.3 1.8 2.3 1.8.9 0 1.3-.6 2.3-.6 1.1 0 1.4.6 2.4.6 1 0 1.6-.9 2.2-1.8.7-1 1-2 1-2.1-.1 0-2.1-.8-2.1-3z"
            fill="currentColor"
            opacity="0.85"
          />
        </svg>
      );

    case "docker":
      return (
        <svg {...iconProps}>
          <path d="M6 10.5h1.8v1.8H6zm2.3 0h1.8v1.8H8.3zm2.3 0h1.8v1.8h-1.8zm-4.6 2.3h1.8v1.8H6zm2.3 0h1.8v1.8H8.3zm2.3 0h1.8v1.8h-1.8zm2.3 0h1.8v1.8h-1.8zm2.3 0h1.8v1.8H13zm-4.6-4.6h1.8v1.8H8.3z" fill="#2496ED" />
          <path d="M19.5 13.2c-.5-.4-1.3-.5-2-.2-.2-.8-.7-1.5-1.5-1.8l-.5 1c-.3 0-5.5 0-7.5 1.8-.7.6-1.5 1.6-1.5 2.7 0 1.5 1.2 2.5 3 2.5 4.5 0 8.5-2 10.5-6z" fill="#2496ED" />
        </svg>
      );

    case "freebsd":
      return (
        <svg {...iconProps}>
          <path d="M7 6c1.5 2 3.5 3.5 5 4-1-2-1.5-4-1-6 2 1.5 3.5 3.5 4 5-1-2-1-4 0-6 2 2 3.5 4.5 3.5 7.5 0 4.2-3.8 7.5-7.5 7.5S4 14.7 4 10.5c0-1.8.8-3.3 3-4.5z" fill="#AB2B28" opacity="0.9" />
        </svg>
      );

    case "linux":
      return (
        <svg {...iconProps}>
          <ellipse cx="12" cy="13" rx="5" ry="6" fill="currentColor" opacity="0.85" />
          <ellipse cx="12" cy="7" rx="3.5" ry="3.5" fill="currentColor" opacity="0.85" />
          <polygon points="12,7.5 10.8,9 13.2,9" fill="#F59E0B" />
          <ellipse cx="12" cy="14" rx="3.5" ry="4" fill="var(--panel, #ffffff)" />
          <ellipse cx="9.5" cy="19" rx="2" ry=".9" fill="#F59E0B" />
          <ellipse cx="14.5" cy="19" rx="2" ry=".9" fill="#F59E0B" />
        </svg>
      );

    case "server":
    default:
      return <Server size={size} style={style} />;
  }
}
