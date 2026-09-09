export const terminalKey = (profileId: string, instanceId?: string) =>
  instanceId ? `${profileId}:terminal:${instanceId}` : profileId;

export const sameTerminal = (tab: { profileId: string; instanceId?: string }, profileId: string, instanceId?: string) =>
  tab.profileId === profileId && (tab.instanceId || "") === (instanceId || "");
