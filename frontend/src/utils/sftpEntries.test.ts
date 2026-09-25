import { describe, expect, it } from "vitest";
import { formatSkippedEntries, remoteEntryTitle, skipReasonLabelKey } from "./sftpEntries";

const label = (reason: string) => (reason === "unreadable" ? "unreadable" : "symlink");

describe("remoteEntryTitle", () => {
  it("names the target of a link so the row says what it opens", () => {
    expect(remoteEntryTitle({ path: "/var/www/current", isLink: true, linkTarget: "releases/2026-09-26" })).toBe(
      "/var/www/current → releases/2026-09-26",
    );
  });

  it("falls back to the plain path when the server would not resolve the link", () => {
    expect(remoteEntryTitle({ path: "/etc/dangling.conf", isLink: true, linkTarget: "" })).toBe("/etc/dangling.conf");
  });

  it("leaves an ordinary entry alone", () => {
    expect(remoteEntryTitle({ path: "/etc/nginx.conf" })).toBe("/etc/nginx.conf");
  });
});

describe("formatSkippedEntries", () => {
  it("names each skipped entry with the reason it was left out", () => {
    expect(
      formatSkippedEntries(
        [
          { path: "/etc/nginx/sites-enabled", reason: "symlink" },
          { path: "/root/secret", reason: "unreadable" },
        ],
        label,
      ),
    ).toBe("sites-enabled (symlink), secret (unreadable)");
  });

  it("marks the list as truncated instead of growing without bound", () => {
    const skips = [1, 2, 3, 4, 5].map((n) => ({ path: `/usr/bin/link${n}`, reason: "symlink" }));
    expect(formatSkippedEntries(skips, label)).toBe("link1 (symlink), link2 (symlink), link3 (symlink) …");
  });

  it("returns nothing for a download that left nothing behind", () => {
    expect(formatSkippedEntries([], label)).toBe("");
  });
});

describe("skipReasonLabelKey", () => {
  it("maps the backend's reasons to translated labels", () => {
    expect(skipReasonLabelKey("unreadable")).toBe("folderSkipUnreadable");
    expect(skipReasonLabelKey("symlink")).toBe("folderSkipSymlink");
  });

  it("uses a neutral label for a reason this build does not know", () => {
    // Falling back to one of the known reasons would make the summary claim a
    // cause that is not the real one.
    expect(skipReasonLabelKey("something-new")).toBe("folderSkipOther");
  });
});
