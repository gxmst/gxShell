import { types } from "../../wailsjs/go/models";

export function cliTrustDeadline(profile: types.Profile): number {
  const deadline = Date.parse(String(profile.cliTrustUntil || ""));
  return Number.isFinite(deadline) ? deadline : 0;
}

export function isCliTrustActive(profile: types.Profile, now: number): boolean {
  const remaining = cliTrustDeadline(profile) - now;
  return Boolean(profile.cliEnabled && remaining > 0 &&
    (!profile.cliTrustMode || (profile.cliTrustMode === "full" && remaining <= 60 * 60 * 1000)));
}

export function formatCliTrustRemaining(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours}:${minutes.toString().padStart(2, "0")}:${rest.toString().padStart(2, "0")}`;
}
