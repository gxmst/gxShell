import { Activity, Command, Folder, Settings, TerminalSquare } from "lucide-react";
import { types } from "../wailsjs/go/models";
import type { Drawer } from "./types";

export const appThemes = ["Dark", "Deep Blue", "Light"];

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
    favorite: false
  });

export const terminalThemes: Record<string, any> = {
  Dark: {
    background: "#030b16",
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
  "gx Dark": {
    background: "#030b16",
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
    cyan: "#6ce5e8"
  },
  Light: {
    background: "#f4f7fb",
    foreground: "#1e293b",
    cursor: "#2563eb",
    selectionBackground: "#bfdbfe",
    red: "#dc2626",
    green: "#15803d",
    yellow: "#b45309",
    blue: "#2563eb",
    magenta: "#7c3aed",
    cyan: "#0891b2"
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
  return <Settings size={size} />;
}

export function navLabel(item: Drawer) {
  if (item === "sftp") return "Files";
  if (item === "commands") return "Cmd";
  return item[0].toUpperCase() + item.slice(1);
}

export function AppIcon() {
  return <TerminalSquare size={18} />;
}

