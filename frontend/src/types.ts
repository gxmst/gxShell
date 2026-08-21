import { types } from "../wailsjs/go/models";

export type Drawer = "monitor" | "sftp" | "commands" | "tunnels" | "logs" | "containers" | "services" | "firewall" | "cron" | "websites" | "recordings" | "ai" | "settings";

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
  /** Stable UI identity that survives a physical SSH session replacement. */
  runtimeId?: string;
  connectionGeneration?: number;
  profileId: string;
  title: string;
  state: string;
  unread?: boolean;
  pinned?: boolean;
  customTitle?: boolean;
  local?: boolean;
  error?: string;
  type?: 'ssh' | 'local' | 'markdown';
  filePath?: string;
  markdownSource?: MarkdownSource;
  remotePath?: string;
  remoteSessionId?: string;
};

/**
 * The short-lived notification shown in the lower corner of the window.
 *
 * `tone` and the first three fields are intentionally kept compatible with
 * the original toast API.  The optional activity fields let the same event
 * be promoted to the Activity Center without forcing every existing caller
 * to change at once.
 */
export type ToastTone = "info" | "error" | "success" | "warning";

export type ActivitySeverity = ToastTone;

export type ActivityCategory =
  | "connection"
  | "transfer"
  | "automation"
  | "security"
  | "terminal"
  | "update"
  | "system"
  | "other";

export type ActivityAction = {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  /** Runtime-only callback. It is deliberately not persisted to disk. */
  onClick?: () => void;
};

export type Toast = {
  id: string;
  tone: ToastTone;
  text: string;
  title?: string;
  category?: ActivityCategory;
  scope?: string;
  scopeLabel?: string;
  actions?: ActivityAction[];
};

/** A durable, reviewable item in the Activity/Notification Center. */
export type ActivityRecord = {
  id: string;
  timestamp: number;
  text: string;
  title?: string;
  tone: ActivitySeverity;
  severity: ActivitySeverity;
  category: ActivityCategory;
  scope?: string;
  scopeLabel?: string;
  dedupeKey?: string;
  unread: boolean;
  /** Number of coalesced occurrences when a producer uses `dedupeKey`. */
  occurrences?: number;
  detail?: string;
  actions?: ActivityAction[];
  source?: string;
  metadata?: Record<string, string | number | boolean>;
};

export type NotifyOptions = {
  text: string;
  title?: string;
  tone?: ToastTone;
  /** Alias for tone for callers that use the activity vocabulary. */
  severity?: ActivitySeverity;
  category?: ActivityCategory;
  /** Stable scope identifier, for example a session/profile id. */
  scope?: string;
  /** Human-readable scope shown in the center, for example a server name. */
  scopeLabel?: string;
  /** Repeated events with the same key are coalesced in the history. */
  dedupeKey?: string;
  detail?: string;
  actions?: ActivityAction[];
  source?: string;
  metadata?: Record<string, string | number | boolean>;
  /** Keep this item in the durable activity history (default: true for the object API). */
  persist?: boolean;
  /** Show the short-lived toast (default: true). */
  toast?: boolean;
  /** Auto-dismiss delay for the short-lived toast. */
  durationMs?: number;
};

export type NotifyInput = string | NotifyOptions;

export type AutomationActivitySource = "ai" | "cli";
export type AutomationActivityPhase = "started" | "completed" | "failed";

export type AutomationActivityEvent = {
  sessionId: string;
  runtimeId?: string;
  generation?: number;
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
  riskTier?: string;
  riskLabel?: string;
  approval?: string;
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

export type CliRiskSpan = {
  start: number;
  end: number;
  class: "tier-driver" | "amplifier" | "opaque" | "credential" | "network";
  note?: string;
};

export type CliApprovalEvent = {
  id: string;
  alias?: string;
  phase: "pending" | "approved" | "denied";
  command?: string;
  riskTier?: string;
  riskLabel?: string;
  strength?: "click";
  riskLines?: string[];
  spans?: CliRiskSpan[];
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
