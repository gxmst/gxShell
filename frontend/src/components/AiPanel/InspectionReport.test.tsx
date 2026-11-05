import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InspectionReport } from "./InspectionReport";
import type { InspectionRun } from "../../../wailsjs/go/workflow";
import { ReviewAiInspectionUnknown, CompareAiInspections, PrepareAiInspectionPlan, ExecuteAiInspectionPlan } from "../../../wailsjs/go/app/App";

vi.mock("../../../wailsjs/go/app/App", () => ({
  ReviewAiInspectionUnknown: vi.fn(), CompareAiInspections: vi.fn(), PrepareAiInspectionPlan: vi.fn(),
  ExecuteAiInspectionPlan: vi.fn(), DismissAiInspectionPlan: vi.fn(), CancelAiInspection: vi.fn(),
  GetAiHostDossier: vi.fn(), SaveAiHostDossier: vi.fn(), DeleteAiHostDossier: vi.fn(), FeedbackAiInspection: vi.fn(), StartAiInspectionFollowup: vi.fn(),
}));
const report = (): InspectionRun => ({
  id: "report-a", revision: 1, workflow: "host_inspection", sessionId: "ssh-a", profileId: "server-a", target: "Server A",
  state: "completed", step: "", createdAt: "2026-11-06T01:00:00Z", finishedAt: "2026-11-06T01:01:00Z",
  evidence: [{ id: "E7", query: { check: "containers" }, status: "unavailable", output: "docker: not found", exitCode: 127, remoteState: "exited", truncated: false }],
  report: "# Report", rounds: 0, promptTokens: 1, completionTokens: 1, provider: "openai", model: "test", language: "zh-CN",
  document: { version: 1, verdict: "unknown", summary: "容器信息待核实。",
    checks: [{ check: "containers", status: "unknown", reading: "Docker 不可用。", evidenceIds: ["E7"] }],
    findings: [], unknowns: [{ id: "unknown-containers", title: "容器部署情况", detail: "需核实是否使用容器。", evidenceIds: ["E7"] }] },
});
const props = () => ({ locale: "zh-CN", onUpdated: vi.fn(), onError: vi.fn(), onSelectRun: vi.fn() });
beforeEach(() => vi.clearAllMocks());

describe("human review and follow-up", () => {
  it("saves the selected result and note for the exact item, then allows withdrawal", async () => {
    const run = report(), callbacks = props();
    const reviewed: InspectionRun = { ...run, revision: 2, reviews: [{ unknownId: "unknown-containers", outcome: "not_applicable", note: "未部署容器", reviewer: "local-operator", at: "2026-11-06T02:00:00Z" }] };
    vi.mocked(ReviewAiInspectionUnknown).mockResolvedValue(reviewed);
    const view = render(<InspectionReport run={run} {...callbacks} />);
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    fireEvent.change(screen.getByRole("combobox", { name: "核实结果" }), { target: { value: "not_applicable" } });
    fireEvent.change(screen.getByRole("textbox", { name: "核实说明（可选）" }), { target: { value: "未部署容器" } });
    fireEvent.click(screen.getByRole("button", { name: "保存确认" }));
    await waitFor(() => expect(ReviewAiInspectionUnknown).toHaveBeenCalledWith("report-a", "unknown-containers", "not_applicable", "未部署容器"));
    await waitFor(() => expect(callbacks.onUpdated).toHaveBeenCalledWith(reviewed));
    view.rerender(<InspectionReport run={reviewed} {...callbacks} />);
    expect(screen.getByText(/AI 原结论/)).toHaveTextContent("未确认");
    expect(screen.getByRole("table")).toHaveTextContent("已人工核实");
    expect(run.document?.verdict).toBe("unknown");
    expect(run.document?.checks[0].status).toBe("unknown");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "撤回确认" }));
    await waitFor(() => expect(ReviewAiInspectionUnknown).toHaveBeenLastCalledWith("report-a", "unknown-containers", "pending", "未部署容器"));
  });
  it("shows manually confirmed issues as attention and keeps unrelated checks pending", () => {
    const run = report();
    run.document!.checks.push({ check: "ports", status: "unknown", reading: "端口未确认", evidenceIds: ["E6"] });
    run.document!.unknowns.push({ id: "ports", title: "端口", detail: "待核实", evidenceIds: ["E6"] });
    run.reviews = [{ unknownId: "unknown-containers", outcome: "issue", note: "", reviewer: "operator", at: "2026-11-06T02:00:00Z" }];
    render(<InspectionReport run={run} {...props()} />);
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveTextContent("需关注项");
    expect(rows[2]).toHaveTextContent("未确认");
    expect(screen.queryByText("已人工核实 · AI 原结论")).not.toBeInTheDocument();
  });
  it("reports a failed save without claiming the confirmation persisted", async () => {
    vi.mocked(ReviewAiInspectionUnknown).mockRejectedValue(new Error("storage failed"));
    const callbacks = props();
    render(<InspectionReport run={report()} {...callbacks} />);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "保存确认" }));
    await waitFor(() => expect(callbacks.onError).toHaveBeenCalledWith("Error: storage failed"));
    expect(callbacks.onUpdated).not.toHaveBeenCalled();
    expect(screen.getByRole("table")).toHaveTextContent("未确认");
  });
  it("offers only earlier compatible reports and compares their stored IDs", async () => {
    const run = report(), callbacks = props();
    const baseline = { ...run, id: "baseline", createdAt: "2026-11-05T01:00:00Z" };
    const otherServer = { ...baseline, id: "other", profileId: "other-server" };
    const otherWorkflow = { ...baseline, id: "disk", workflow: "disk_diagnosis" };
    vi.mocked(CompareAiInspections).mockResolvedValue(run);
    render(<InspectionReport run={run} history={[baseline, otherServer, otherWorkflow]} {...callbacks} />);
    expect(within(screen.getByRole("combobox", { name: "基准报告" })).getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    await waitFor(() => expect(CompareAiInspections).toHaveBeenCalledWith("report-a", "baseline"));
  });
  it("prepares a backend plan, executes only its ID and opens the separate verification", async () => {
    const run = report(), callbacks = props();
    run.workflow = "service_diagnosis"; run.service = "nginx.service"; run.port = 80;
    run.evidence.push({ id: "E8", query: { check: "service", view: "status", service: "nginx.service" }, status: "collected", output: "LoadState=loaded\nActiveState=inactive", exitCode: 0, remoteState: "exited", truncated: false });
    const view = render(<InspectionReport run={run} {...callbacks} />);
    expect(screen.queryByRole("button", { name: "生成服务重启计划" })).not.toBeInTheDocument();
    expect(screen.getByText(/不是 root/)).toBeInTheDocument();
    run.evidence.push({ id: "E9", query: { check: "system" }, status: "collected", output: "Linux\nGXSHELL_UID=0", exitCode: 0, remoteState: "exited", truncated: false });
    const prepared: InspectionRun = { ...run, plans: [{ id: "plan-a", kind: "restart_service", command: "systemctl restart -- 'nginx.service'", title: "重启所选服务", impact: "服务会短暂中断。", status: "proposed", exitCode: 0, createdAt: "", startedAt: "", finishedAt: "" }] };
    vi.mocked(PrepareAiInspectionPlan).mockResolvedValue(prepared);
    view.rerender(<InspectionReport run={{ ...run }} {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "生成服务重启计划" }));
    await waitFor(() => expect(PrepareAiInspectionPlan).toHaveBeenCalledWith("report-a", "restart_service"));
    view.rerender(<InspectionReport run={prepared} {...callbacks} />);
    const verified = { ...prepared, plans: prepared.plans!.map((p) => ({ ...p, status: "completed", verificationId: "verification-a" })) };
    vi.mocked(ExecuteAiInspectionPlan).mockResolvedValue(verified);
    expect(screen.getByText("systemctl restart -- 'nginx.service'")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "审核并执行" }));
    await waitFor(() => expect(ExecuteAiInspectionPlan).toHaveBeenCalledWith("report-a", "plan-a"));
    view.rerender(<InspectionReport run={verified} {...callbacks} />);
    fireEvent.click(screen.getByRole("button", { name: "查看复查报告" }));
    expect(callbacks.onSelectRun).toHaveBeenCalledWith("verification-a");
  });
});
