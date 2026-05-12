import { types } from "../wailsjs/go/models";

export type Drawer = "monitor" | "sftp" | "commands" | "downloads" | "settings";

export type Tab = {
  id: string;
  profileId: string;
  title: string;
  state: string;
  error?: string;
};

export type Toast = {
  id: number;
  tone: "info" | "error" | "success";
  text: string;
};

export type SecretRequest = {
  profile: types.Profile;
  mode: "connect" | "reconnect";
  sessionId?: string;
};

export type GlobalSearchResult = {
  type: string;
  title: string;
  subtitle: string;
  action: () => void;
};

