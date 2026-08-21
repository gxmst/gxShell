import { describe, expect, it } from "vitest";
import { parseOsc7Directory } from "./terminalCwd";

describe("parseOsc7Directory", () => {
  it("parses POSIX and Windows file URLs", () => {
    expect(parseOsc7Directory("file://server/home/alice/My%20Project")).toEqual({ host: "server", path: "/home/alice/My Project" });
    expect(parseOsc7Directory("file:///C:/Users/Alice/Work")).toEqual({ path: "C:/Users/Alice/Work" });
  });

  it("rejects malformed, non-file, and control-bearing payloads", () => {
    expect(parseOsc7Directory("https://example.test/tmp")).toBeNull();
    expect(parseOsc7Directory("not a url")).toBeNull();
    expect(parseOsc7Directory("file:///tmp\u0007bad")).toBeNull();
  });
});
