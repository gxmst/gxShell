import { Activity, ArrowRightLeft, Bot, Box, CalendarClock, Cog, Command, FileText, Folder, Globe2, Settings, Shield, Video } from "lucide-react";
import { types } from "../wailsjs/go/models";
import type { Drawer } from "./types";

export const appThemes = [
  "Light",
  "Yuzu Study",
  "Sakura Mist",
  "Matcha Green",
  "Dark",
  // Keep the pre-1.7 names so existing settings remain valid after upgrade.
  "Deep Blue",
  "Ember Terminal",
  "Twilight Amber",
];

export const fontPresets = [
  "JetBrains Mono, Cascadia Code, Consolas, monospace",
  "Cascadia Code, Consolas, monospace",
  "Fira Code, Consolas, monospace",
  "Maple Mono, Consolas, monospace",
  "Iosevka, Consolas, monospace",
  "Source Code Pro, Consolas, monospace",
  "Hack, Consolas, monospace",
  "Inconsolata, Consolas, monospace",
  "Victor Mono, Consolas, monospace",
  "IBM Plex Mono, Consolas, monospace",
  "Ubuntu Mono, Consolas, monospace",
  "Menlo, Monaco, Consolas, monospace",
  "Consolas, monospace",
  "Courier New, monospace",
];

// Theme names double as the persisted settings value and the data-theme
// attribute, so only the display label is localized — the keys stay English.
const themeNamesZh: Record<string, string> = {
  "Light": "浅色",
  "Yuzu Study": "柚语书房",
  "Sakura Mist": "樱雾",
  "Matcha Green": "抹茶青",
  "Dark": "深色",
  "Deep Blue": "深海蓝",
  "Ember Terminal": "余烬终端",
  "Twilight Amber": "暮色琥珀",
  "gx Dark": "gx 深色",
};

export function themeDisplayName(theme: string, lang?: string): string {
  return lang === "zh-CN" ? themeNamesZh[theme] || theme : theme;
}

export const emptyProfile = (): types.Profile =>
  new types.Profile({
    id: "",
    name: "",
    group: "Default",
    host: "",
    port: 22,
    username: "root",
    authType: "password",
    password: "",
    privateKeyPath: "",
    privateKeyPassphrase: "",
    description: "",
    tags: [],
    favorite: false,
    cliEnabled: false,
    cliAlias: ""
  });

export const terminalThemes: Record<string, any> = {
  Light: {
    background: "#f4f7fb",
    foreground: "#1e293b",
    cursor: "#2563eb",
    selectionBackground: "#bfdbfe",
    black: "#1e293b",
    red: "#dc2626",
    green: "#15803d",
    yellow: "#b45309",
    blue: "#2563eb",
    magenta: "#7c3aed",
    cyan: "#0284c7",
    white: "#475569",
    brightBlack: "#64748b",
    brightRed: "#b91c1c",
    brightGreen: "#166534",
    brightYellow: "#92400e",
    brightBlue: "#1d4ed8",
    brightMagenta: "#6b21a8",
    brightCyan: "#0369a1",
    brightWhite: "#0f172a"
  },
  "Yuzu Study": {
    background: "#fffdf9",
    foreground: "#342519",
    cursor: "#b4692c",
    selectionBackground: "#eddcc8",
    black: "#4a3826",
    red: "#c0492f",
    green: "#4d7c1f",
    yellow: "#a16207",
    blue: "#2563eb",
    magenta: "#8c5d30",
    cyan: "#0e7490",
    white: "#6b5640",
    brightBlack: "#78716c",
    brightRed: "#991b1b",
    brightGreen: "#365314",
    brightYellow: "#854d0e",
    brightBlue: "#1e40af",
    brightMagenta: "#581c87",
    brightCyan: "#155e75",
    brightWhite: "#1c1917"
  },
  "Sakura Mist": {
    background: "#fdf7fa",
    foreground: "#3b2533",
    cursor: "#d44d7d",
    selectionBackground: "#f5d4e4",
    black: "#3b2533",
    red: "#dc2626",
    green: "#15803d",
    yellow: "#b45309",
    blue: "#7c3aed",
    magenta: "#d44d7d",
    cyan: "#0284c7",
    white: "#7d5a71",
    brightBlack: "#8c6b80",
    brightRed: "#b91c1c",
    brightGreen: "#166534",
    brightYellow: "#92400e",
    brightBlue: "#6b21a8",
    brightMagenta: "#be185d",
    brightCyan: "#0369a1",
    brightWhite: "#1f101a"
  },
  "Matcha Green": {
    background: "#f4faf6",
    foreground: "#192e21",
    cursor: "#16a34a",
    selectionBackground: "#cfe8d8",
    black: "#192e21",
    red: "#dc2626",
    green: "#15803d",
    yellow: "#b45309",
    blue: "#0284c7",
    magenta: "#7c3aed",
    cyan: "#0f766e",
    white: "#4e6b57",
    brightBlack: "#5d7a67",
    brightRed: "#b91c1c",
    brightGreen: "#166534",
    brightYellow: "#92400e",
    brightBlue: "#0369a1",
    brightMagenta: "#6b21a8",
    brightCyan: "#115e59",
    brightWhite: "#0a1910"
  },
  Dark: {
    background: "#0b0e13",
    foreground: "#cbd5e1",
    cursor: "#66d9ef",
    selectionBackground: "#284766",
    black: "#0b0f14",
    red: "#ff6b6b",
    green: "#51d88a",
    yellow: "#f6c760",
    blue: "#64d2ff",
    magenta: "#c792ea",
    cyan: "#5de4c7",
    white: "#d7e3f4",
    brightBlack: "#4b5563",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#fde047",
    brightBlue: "#60a5fa",
    brightMagenta: "#c084fc",
    brightCyan: "#38bdf8",
    brightWhite: "#f3f4f6"
  },
  "gx Dark": {
    background: "#0b0e13",
    foreground: "#cbd5e1",
    cursor: "#66d9ef",
    selectionBackground: "#284766",
    black: "#0b0f14",
    red: "#ff6b6b",
    green: "#51d88a",
    yellow: "#f6c760",
    blue: "#64d2ff",
    magenta: "#c792ea",
    cyan: "#5de4c7",
    white: "#d7e3f4"
  },
  "Deep Blue": {
    background: "#06111f",
    foreground: "#d7e3f4",
    cursor: "#8bd3ff",
    selectionBackground: "#1d4f7a",
    red: "#ff7b87",
    green: "#76e4a8",
    yellow: "#ffd166",
    blue: "#7bb7ff",
    magenta: "#b99cff",
    cyan: "#6ce5e8",
    white: "#e2edfc"
  },
  "Ember Terminal": {
    background: "#111210",
    foreground: "#ecf6df",
    cursor: "#9bcf5f",
    selectionBackground: "#3a3f33",
    black: "#0c0d0b",
    red: "#e57158",
    green: "#9bcf5f",
    yellow: "#e0b341",
    blue: "#8fbf7a",
    magenta: "#c6a0d9",
    cyan: "#90d4b0",
    white: "#ecf6df"
  },
  "Twilight Amber": {
    background: "#18120e",
    foreground: "#fff4e6",
    cursor: "#f0a868",
    selectionBackground: "#46352b",
    black: "#120d09",
    red: "#e8745a",
    green: "#9ec96b",
    yellow: "#e6b455",
    blue: "#d19a66",
    magenta: "#d7a6c7",
    cyan: "#c9b36b",
    white: "#fff4e6"
  },
  Nord: { background: "#2e3440", foreground: "#d8dee9", cursor: "#88c0d0" },
  Dracula: { background: "#282a36", foreground: "#f8f8f2", cursor: "#bd93f9" },
  "Tokyo Night": { background: "#1a1b26", foreground: "#c0caf5", cursor: "#7aa2f7" },
  Monokai: { background: "#272822", foreground: "#f8f8f2", cursor: "#f8f8f0" },
  "Solarized Dark": { background: "#002b36", foreground: "#839496", cursor: "#93a1a1" }
};

export function drawerIcon(item: Drawer, size = 15) {
  if (item === "monitor") return <Activity size={size} />;
  if (item === "sftp") return <Folder size={size} />;
  if (item === "commands") return <Command size={size} />;
  if (item === "tunnels") return <ArrowRightLeft size={size} />;
  if (item === "logs") return <FileText size={size} />;
  if (item === "containers") return <Box size={size} />;
  if (item === "services") return <Cog size={size} />;
  if (item === "firewall") return <Shield size={size} />;
  if (item === "cron") return <CalendarClock size={size} />;
  if (item === "websites") return <Globe2 size={size} />;
  if (item === "ai") return <Bot size={size} />;
  if (item === "recordings") return <Video size={size} />;
  return <Settings size={size} />;
}

export function AppIcon() {
  return (
    <img
      src={new URL('./assets/images/logo.png', import.meta.url).href}
      alt="gxShell"
      style={{ width: 28, height: 28, objectFit: 'contain' }}
    />
  );
}
