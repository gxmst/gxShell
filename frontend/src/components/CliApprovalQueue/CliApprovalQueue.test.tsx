import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CliApprovalQueue } from "./CliApprovalQueue";
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

// The card used a local `const zh = locale === "zh-CN"` flag, so its labels
// stayed Chinese under an English interface (and vice versa).
describe("CliApprovalQueue locale", () => {
  const approval = () => ({
    id: "a1",
    phase: "pending" as const,
    command: "rm -rf /etc",
    riskTier: "T3",
    riskLabel: "irreversible",
    riskLines: ["deletes a system path"],
  });

  it("localizes the card chrome in zh-CN", () => {
    render(<CliApprovalQueue approvals={[approval()]} locale="zh-CN" />);

    expect(screen.getByText("远程服务器")).toBeInTheDocument();
    expect(screen.getByText("等待原生授权")).toBeInTheDocument();
    expect(screen.getByLabelText("命令风险分析")).toBeInTheDocument();
    expect(screen.getByText("作用说明")).toBeInTheDocument();
  });

  it("falls back to English for other locales", () => {
    render(<CliApprovalQueue approvals={[approval()]} locale="en" />);

    expect(screen.getByText("Remote server")).toBeInTheDocument();
    expect(screen.getByText("Native approval pending")).toBeInTheDocument();
    expect(screen.getByText("What this does")).toBeInTheDocument();
  });

  it("prefers the alias when one is present", () => {
    render(<CliApprovalQueue approvals={[{ ...approval(), alias: "prod-web-1" }]} locale="zh-CN" />);

    expect(screen.getByText("prod-web-1")).toBeInTheDocument();
    expect(screen.queryByText("远程服务器")).not.toBeInTheDocument();
  });
});
