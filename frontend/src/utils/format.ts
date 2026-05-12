import { types } from "../../wailsjs/go/models";
import { appThemes, terminalThemes } from "../constants";

export function stateClass(state: string) {
  if (state === "connected") return "bg-ok";
  if (state === "connecting") return "bg-warn";
  if (state === "error") return "bg-bad";
  return "bg-muted";
}

export function normalizeAppTheme(theme?: string): string {
  return appThemes.includes(theme || "") ? theme || "Light" : "Light";
}

export function getTerminalTheme(settings: types.AppSettings) {
  const requested = settings.terminal.themeName || settings.themeName || "Light";
  return terminalThemes[requested] || terminalThemes[normalizeAppTheme(settings.themeName)] || terminalThemes["Light"];
}

export function needsSecret(profile: types.Profile) {
  return !profile.rememberPassword && (profile.authType === "password" || profile.authType === "privateKey");   
}

export function tabTitle(profile?: types.Profile, fallback?: string) {
  if (!profile) return fallback || "Shell";
  const name = (profile.name || "").trim();
  if (name && name.length > 1) return name;
  const userHost = `${profile.username || "ssh"}@${shortHost(profile.host)}`;
  return userHost;
}

export function shortHost(host = "") {
  if (host.length <= 18) return host;
  return `${host.slice(0, 8)}...${host.slice(-5)}`;
}

export function formatBytes(value: number) {
  if (!value) return "-";
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB/s`;
  if (value > 1024) return `${(value / 1024).toFixed(1)} KB/s`;
  return `${value} B/s`;
}

export function formatFileSize(value: number) {
  if (!value) return "0 B";
  if (value > 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)}G`;
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}M`;
  if (value > 1024) return `${(value / 1024).toFixed(1)}K`;
  return `${value}B`;
}
