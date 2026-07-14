import { types } from "../wailsjs/go/models";

export type Drawer = "monitor" | "sftp" | "commands" | "tunnels" | "logs" | "containers" | "recordings" | "ai" | "settings";

export type SplitDirection = "horizontal" | "vertical";

export type SplitPane = {
  left: string;
  right: string;
  direction: SplitDirection;
  ratio: number;
};

export type MarkdownSource = "local" | "remote";

export type MarkdownOpenTarget =
  | { source: "local"; path: string }
  | { source: "remote"; sessionId: string; path: string };

export type RecentMarkdownItem = {
  id: string;
  source: MarkdownSource;
  path: string;
  title: string;
  openedAt: number;
  sessionId?: string;
  profileId?: string;
  host?: string;
};

export type Tab = {
  id: string;
  profileId: string;
  title: string;
  state: string;
  local?: boolean;
  error?: string;
  type?: 'ssh' | 'local' | 'markdown';
  filePath?: string;
  markdownSource?: MarkdownSource;
  remotePath?: string;
  remoteSessionId?: string;
};

export type Toast = {
  id: number;
  tone: "info" | "error" | "success";
  text: string;
};

export type AutomationActivitySource = "ai" | "cli";
export type AutomationActivityPhase = "started" | "completed" | "failed";

export type AutomationActivityEvent = {
  sessionId: string;
  activityId: string;
  source: AutomationActivitySource;
  phase: AutomationActivityPhase;
  tool?: string;
  command?: string;
  output?: string;
  error?: string;
  exitCode?: number;
  durationMs?: number;
  truncated?: boolean;
};

export type AutomationActivityRecord = AutomationActivityEvent & {
  timestamp: number;
  title?: string;
};

export type AutomationIndicator = {
  source: AutomationActivitySource;
  phase: AutomationActivityPhase;
  running: number;
  updatedAt: number;
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
