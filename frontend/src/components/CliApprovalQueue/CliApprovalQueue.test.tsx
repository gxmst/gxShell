import { describe, expect, it } from "vitest";
import { splitRiskText } from "./riskText";

describe("splitRiskText", () => {
  it("uses UTF-8 byte offsets without shifting non-ASCII text", () => {
    const command = "echo 中文; rm -rf /etc";
    const prefix = "echo 中文; rm -rf ";
    const start = new TextEncoder().encode(prefix).length;
    const end = start + new TextEncoder().encode("/etc").length;
    const parts = splitRiskText(command, [{ start, end, class: "tier-driver", note: "system path" }]);
    expect(parts.map((part) => part.text).join("")).toBe(command);
    expect(parts.find((part) => part.className)?.text).toBe("/etc");
  });
});
