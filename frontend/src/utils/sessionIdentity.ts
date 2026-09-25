export const terminalKey = (profileId: string, instanceId?: string) =>
  instanceId ? `${profileId}:terminal:${instanceId}` : profileId;

export const sameTerminal = (tab: { profileId: string; instanceId?: string }, profileId: string, instanceId?: string) =>
  tab.profileId === profileId && (tab.instanceId || "") === (instanceId || "");

/**
 * Whether a tab is a live remote SSH session — the only kind the
 * server-inspecting panels can act on. A local terminal and a Markdown document
 * both have a tab id, but neither has an SSH session behind it, so polling one
 * only produces "session not found" every interval.
 */
export const isRemoteSession = <T extends { state?: string; local?: boolean; type?: string }>(
  tab?: T | null,
): tab is T & { state: "connected" } =>
  !!tab && tab.state === "connected" && !tab.local && tab.type !== "markdown";

