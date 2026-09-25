import { describe, expect, it } from "vitest";
import { isRemoteSession, sameTerminal, terminalKey } from "./sessionIdentity";

describe("sessionIdentity", () => {
  it("builds a stable key per profile and instance", () => {
    expect(terminalKey("one")).toBe("one");
    expect(terminalKey("one", "inst")).toBe("one:terminal:inst");
    expect(sameTerminal({ profileId: "one" }, "one", "")).toBe(true);
    expect(sameTerminal({ profileId: "one" }, "one", "inst")).toBe(false);
  });

  it("accepts only a live remote SSH session", () => {
    expect(isRemoteSession({ state: "connected", profileId: "one" })).toBe(true);
    // The panels gate polling on this: a local terminal and a Markdown document
    // both carry a tab id but have no SSH session behind them.
    expect(isRemoteSession({ state: "connected", local: true })).toBe(false);
    expect(isRemoteSession({ state: "connected", type: "markdown" })).toBe(false);
    expect(isRemoteSession({ state: "disconnected" })).toBe(false);
    expect(isRemoteSession({ state: "reconnecting" })).toBe(false);
    expect(isRemoteSession(undefined)).toBe(false);
    expect(isRemoteSession(null)).toBe(false);
  });
});
