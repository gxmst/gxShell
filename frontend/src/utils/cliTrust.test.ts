import { describe, expect, it } from "vitest";
import { types } from "../../wailsjs/go/models";
import { cliTrustDeadline, formatCliTrustRemaining, isCliTrustActive } from "./cliTrust";

function profile(deadline?: string, enabled = true) {
  return new types.Profile({ cliEnabled: enabled, cliTrustUntil: deadline });
}

describe("CLI timed trust display", () => {
  it("formats the remaining wall-clock time", () => {
    expect(formatCliTrustRemaining(4 * 60 * 60 * 1000 + 61_001)).toBe("4:01:02");
    expect(formatCliTrustRemaining(-1)).toBe("0:00:00");
  });

  it("only treats enabled profiles with a future deadline as active", () => {
    const now = Date.parse("2026-07-28T08:00:00Z");
    const future = "2026-07-28T09:00:00Z";
    expect(cliTrustDeadline(profile(future))).toBe(Date.parse(future));
    expect(isCliTrustActive(profile(future), now)).toBe(true);
    expect(isCliTrustActive(profile(future, false), now)).toBe(false);
    expect(isCliTrustActive(profile("2026-07-28T07:59:59Z"), now)).toBe(false);
    expect(isCliTrustActive(profile("not-a-date"), now)).toBe(false);
  });
});
