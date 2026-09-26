import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { types } from "../../../wailsjs/go/models";
import type { ActionContext, ActionDefinition } from "../../actions/actionRegistry";
import { BatchCommandDialog } from "./BatchCommandDialog";
import { BulkProfilesModal } from "./BulkProfilesModal";
import { PasteConfirmDialog } from "./PasteConfirmDialog";
import { ShortcutHelpDialog } from "./ShortcutHelpDialog";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";

// All five dialogs picked their wording with a local `const zh =
// language === "zh-CN"` flag, so every label stayed Chinese under an English
// interface (and vice versa). These cases pin the localized text.

function action(id: string, label: string, category: string, shortcuts: string[]): ActionDefinition<ActionContext> {
  return {
    id,
    label,
    category,
    defaultShortcuts: shortcuts,
    run: vi.fn(),
  } as unknown as ActionDefinition<ActionContext>;
}

describe("BatchCommandDialog locale", () => {
  it("localizes the header, options and footer", () => {
    render(
      <BatchCommandDialog
        request={{ commandName: "Deploy", command: "make deploy", targets: [{ id: "t1", title: "web-1" }] }}
        language="zh-CN"
        running={false}
        sent={0}
        total={1}
        onClose={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByText("批量发送命令")).toBeInTheDocument();
    expect(screen.getByText(/Deploy · 1 个会话/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "发送模式" })).toBeInTheDocument();
    expect(screen.getByText("整体")).toBeInTheDocument();
    expect(screen.getByText("逐行")).toBeInTheDocument();
    expect(screen.getByText("间隔")).toBeInTheDocument();
    expect(screen.getByText("重复")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认发送" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("swaps the footer action to Stop while running", () => {
    render(
      <BatchCommandDialog
        request={{ commandName: "Deploy", command: "make deploy", targets: [{ id: "t1", title: "web-1" }] }}
        language="zh-CN"
        running
        sent={1}
        total={2}
        onClose={vi.fn()}
        onStart={vi.fn()}
        onStop={vi.fn()}
      />,
    );

    expect(screen.getByText("已发送")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /停止/ })).toBeInTheDocument();
  });
});

describe("BulkProfilesModal locale", () => {
  it("localizes the filter, bulk fields and footer", () => {
    render(
      <BulkProfilesModal
        profiles={[new types.Profile({ id: "p1", name: "web-1", host: "10.0.0.1", username: "root", group: "prod" })]}
        language="zh-CN"
        onClose={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByText("批量修改服务器")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("筛选服务器")).toBeInTheDocument();
    expect(screen.getByText("选择筛选结果")).toBeInTheDocument();
    expect(screen.getByText("修改分组")).toBeInTheDocument();
    expect(screen.getByText("修改用户名")).toBeInTheDocument();
    expect(screen.getByText("修改端口")).toBeInTheDocument();
    expect(screen.getByText("自动重连")).toBeInTheDocument();
    expect(screen.getByText("收藏")).toBeInTheDocument();
    expect(screen.getByText("恢复继承全局终端配置")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保存修改/ })).toBeInTheDocument();
  });

  it("reports an empty result set in the interface language", () => {
    render(
      <BulkProfilesModal profiles={[]} language="zh-CN" onClose={vi.fn()} onSave={vi.fn()} />,
    );

    expect(screen.getByText("没有匹配的服务器")).toBeInTheDocument();
    expect(screen.getByText("已选 0 台")).toBeInTheDocument();
  });
});

describe("PasteConfirmDialog locale", () => {
  it("localizes the heading, counts and actions", () => {
    render(
      <PasteConfirmDialog
        request={{ risk: { lines: 3, characters: 120, preview: "rm -rf /" }, broadcastTargets: 1 } as never}
        language="zh-CN"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText("确认粘贴到终端")).toBeInTheDocument();
    expect(screen.getByText("多行或较长文本可能立即执行命令。")).toBeInTheDocument();
    expect(screen.getByText(/3 行/)).toBeInTheDocument();
    expect(screen.getByText(/120 字符/)).toBeInTheDocument();
    expect(screen.getByText("将发送到当前终端")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /仍然粘贴/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("uses the singular for a single line in English", () => {
    render(
      <PasteConfirmDialog
        request={{ risk: { lines: 1, characters: 4, preview: "ls" }, broadcastTargets: 3 } as never}
        language="en"
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText(/1 line$/)).toBeInTheDocument();
    expect(screen.getByText("Will be sent to 3 terminals")).toBeInTheDocument();
  });
});

describe("ShortcutHelpDialog locale", () => {
  it("localizes the title, conflicts, palette hint and footer", () => {
    const bound = action("a1", "Open settings", "App", ["Ctrl+,"]);
    const unbound = action("a2", "Toggle sidebar", "App", []);
    render(
      <ShortcutHelpDialog
        actions={[bound, unbound]}
        conflicts={new Map([["Ctrl+,", [bound]]])}
        language="zh-CN"
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("快捷键")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("1 组快捷键存在冲突");
    expect(screen.getByText("命令面板")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "完成" })).toBeInTheDocument();
  });
});

describe("UnsavedChangesDialog locale", () => {
  it("localizes the title, body and buttons", () => {
    render(
      <UnsavedChangesDialog
        title="notes.md"
        locale="zh-CN"
        onSave={vi.fn(async () => true)}
        onDiscard={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("保存更改？")).toBeInTheDocument();
    expect(screen.getByText("此文档有尚未保存的修改。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "不保存" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消" })).toBeInTheDocument();
  });

  it("keeps an explicit body override", () => {
    render(
      <UnsavedChangesDialog
        title="notes.md"
        locale="zh-CN"
        body="自定义说明"
        onSave={vi.fn(async () => true)}
        onDiscard={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText("自定义说明")).toBeInTheDocument();
  });
});
