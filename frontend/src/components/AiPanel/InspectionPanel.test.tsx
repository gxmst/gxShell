import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InspectionPanel } from "./InspectionPanel";
import type { InspectionRun } from "../../../wailsjs/go/workflow";
import { ListAiInspections, StartAiInspection, StartAiServiceDiagnosis, StartAiDiskDiagnosis, ExportAiInspection, CancelAiInspection } from "../../../wailsjs/go/app/App";

const events = vi.hoisted(() => ({ inspection: undefined as undefined | ((run: InspectionRun) => void) }));
vi.mock("../../../wailsjs/go/app/App", () => ({
  ListAiInspections: vi.fn(), StartAiInspection: vi.fn(), StartAiServiceDiagnosis: vi.fn(), ExportAiInspection: vi.fn(), CancelAiInspection: vi.fn(),
  StartAiDiskDiagnosis: vi.fn(), GetAiInspection: vi.fn(), ReviewAiInspectionUnknown: vi.fn(), CompareAiInspections: vi.fn(),
  PrepareAiInspectionPlan: vi.fn(), ExecuteAiInspectionPlan: vi.fn(), DismissAiInspectionPlan: vi.fn(),
  GetAiHostDossier: vi.fn(), SaveAiHostDossier: vi.fn(), DeleteAiHostDossier: vi.fn(), FeedbackAiInspection: vi.fn(), StartAiInspectionFollowup: vi.fn(),
  ListAiInspectionEvaluationCases: vi.fn(), ListAiInspectionEvaluations: vi.fn(), StartAiInspectionEvaluation: vi.fn(), CancelAiInspectionEvaluation: vi.fn(),
}));
vi.mock("../../../wailsjs/runtime/runtime", () => ({
  EventsOn: vi.fn((_name: string, callback: (run: InspectionRun) => void) => { events.inspection = callback; return () => undefined; }),
}));
const run = (id: string, state = "collecting"): InspectionRun => ({
  id, workflow: "host_inspection", sessionId: "ssh-a", profileId: "a", target: "Server A", state, step: "disk",
  createdAt: "2026-11-06T00:00:00Z", finishedAt: "", evidence: [], report: "", rounds: 0,
  promptTokens: 0, completionTokens: 0, provider: "openai", model: "test", language: "English",
});
const tabs = [
  { id: "ssh-a", profileId: "a", title: "Server A", state: "connected", type: "ssh" as const },
  { id: "ssh-b", profileId: "b", title: "Server B", state: "connected", type: "ssh" as const },
  { id: "local", profileId: "", title: "Local", state: "connected", type: "local" as const, local: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ListAiInspections).mockResolvedValue([]);
  vi.mocked(CancelAiInspection).mockResolvedValue(true);
});

describe("inspection tasks", () => {
  it("starts disk diagnosis against the selected SSH session", async () => {
    vi.mocked(StartAiDiskDiagnosis).mockResolvedValue({ ...run("disk"), workflow: "disk_diagnosis" });
    render(<InspectionPanel locale="en" tabs={tabs} activeTabId="ssh-a" onNotify={vi.fn()} />);
    await waitFor(() => expect(ListAiInspections).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("combobox", { name: "Inspection workflow" }), { target: { value: "disk_diagnosis" } });
    fireEvent.click(screen.getByRole("button", { name: "Start inspection" }));
    await waitFor(() => expect(StartAiDiskDiagnosis).toHaveBeenCalledWith("ssh-a"));
    expect(StartAiInspection).not.toHaveBeenCalled();
  });
  it("ignores older report revisions arriving after a human review event", async () => {
    const completed = { ...run("revision", "completed"), revision: 8, report: "Current saved review" };
    vi.mocked(ListAiInspections).mockResolvedValue([completed]);
    render(<InspectionPanel locale="en" tabs={tabs} activeTabId="ssh-a" onNotify={vi.fn()} />);
    await screen.findByText("Current saved review");
    act(() => events.inspection?.({ ...completed, revision: 7, report: "Stale review" }));
    expect(screen.queryByText("Stale review")).not.toBeInTheDocument();
    expect(screen.getByText("Current saved review")).toBeInTheDocument();
  });
  it("validates diagnosis inputs and starts the selected service workflow", async () => {
    vi.mocked(StartAiServiceDiagnosis).mockResolvedValue(run("diagnosis"));
    render(<InspectionPanel locale="zh-CN" tabs={tabs} activeTabId="ssh-a" onNotify={vi.fn()} />);
    await waitFor(() => expect(ListAiInspections).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("combobox", { name: "巡检工作流" }), { target: { value: "service_diagnosis" } });
    expect(screen.getByRole("button", { name: "开始巡检" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("服务名"), { target: { value: "nginx.service" } });
    fireEvent.change(screen.getByLabelText("TCP 端口"), { target: { value: "8080" } });
    fireEvent.click(screen.getByRole("button", { name: "开始巡检" }));
    await waitFor(() => expect(StartAiServiceDiagnosis).toHaveBeenCalledWith("ssh-a", "nginx.service", 8080));
    expect(StartAiInspection).not.toHaveBeenCalled();
  });
  it("opens the structured report, reveals evidence and exports the exact run", async () => {
    const completed = run("structured", "completed");
    completed.language = "zh-CN";
    completed.report = "# 主机巡检报告\n\n磁盘使用率 90%";
    completed.evidence = [{ id: "E3", query: { check: "disk" }, status: "collected", output: "/dev/vda1 90% /", exitCode: 0, remoteState: "exited", truncated: false }];
    completed.document = { version: 1, verdict: "attention", summary: "磁盘空间需要关注。",
      checks: [{ check: "disk", status: "warning", reading: "根分区使用率偏高。", evidenceIds: ["E3"], observed: "/ · 90%" }],
      findings: [{ severity: "warning", title: "磁盘空间不足", detail: "根分区使用率 90%。", impact: "可用空间有限。", recommendation: "检查占用较大的目录。", evidenceIds: ["E3"] }], unknowns: [] };
    vi.mocked(ListAiInspections).mockResolvedValue([completed]);
    vi.mocked(ExportAiInspection).mockResolvedValue("report.md");
    const notify = vi.fn();
    render(<InspectionPanel locale="zh-CN" tabs={tabs} activeTabId="ssh-a" onNotify={notify} />);
    await screen.findByText("磁盘空间需要关注。");
    fireEvent.click(screen.getByRole("button", { name: "查看完整报告" }));
    const dialog = screen.getByRole("dialog", { name: "查看完整报告" });
    expect(dialog).toHaveTextContent("关键读数与判断");
    expect(dialog).toHaveTextContent("/ · 90%");
    fireEvent.click(screen.getAllByRole("button", { name: "[E3]" })[0]);
    expect(document.getElementById("report-structured-E3")).toHaveAttribute("open");
    expect(document.getElementById("report-structured-evidence")).toHaveAttribute("open");
    fireEvent.click(screen.getAllByRole("button", { name: "导出 MD" })[1]);
    await waitFor(() => expect(ExportAiInspection).toHaveBeenCalledWith("structured"));
    expect(notify).toHaveBeenCalledWith("报告已导出。", "success");
  });
  it("starts only against the selected remote server", async () => {
    vi.mocked(StartAiInspection).mockResolvedValue(run("run-a"));
    render(<InspectionPanel locale="en" tabs={tabs} activeTabId="ssh-a" onNotify={vi.fn()} />);
    await waitFor(() => expect(ListAiInspections).toHaveBeenCalled());
    expect(screen.queryByRole("option", { name: "Local" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Inspection server" }), { target: { value: "ssh-b" } });
    fireEvent.click(screen.getByRole("button", { name: "Start inspection" }));
    await waitFor(() => expect(StartAiInspection).toHaveBeenCalledWith("ssh-b"));
  });
  it("keeps the task target when another terminal is selected and cancels the exact run", async () => {
    vi.mocked(ListAiInspections).mockResolvedValue([run("run-a")]);
    const props = { locale: "en", tabs, activeTabId: "ssh-a", onNotify: vi.fn() };
    const view = render(<InspectionPanel {...props} />);
    await screen.findByRole("status");
    view.rerender(<InspectionPanel {...props} activeTabId="ssh-b" />);
    expect(screen.getByRole("status")).toHaveTextContent("Server A");
    fireEvent.click(screen.getByTitle(/Stop/));
    await waitFor(() => expect(CancelAiInspection).toHaveBeenCalledWith("run-a"));
  });
  it("shows unavailable checks separately from collected checks", async () => {
    const completed = run("finished", "completed");
    completed.evidence = [{ id: "E1", query: { check: "disk" }, status: "unavailable", error: "permission denied", output: "", exitCode: 1, remoteState: "exited", truncated: false }];
    completed.report = "## Report\n\nDisk could not be checked.";
    vi.mocked(ListAiInspections).mockResolvedValue([completed]);
    render(<InspectionPanel locale="en" tabs={tabs} activeTabId="ssh-a" onNotify={vi.fn()} />);
    await screen.findByText("Disk could not be checked.");
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not checked").length).toBeGreaterThan(0);
  });
  it("shows only the selected server's reports and history", async () => {
    const completed = { ...run("report-a", "completed"), report: "Report for server A" };
    vi.mocked(ListAiInspections).mockResolvedValue([completed]);
    render(<InspectionPanel locale="en" tabs={tabs} activeTabId="ssh-a" onNotify={vi.fn()} />);
    await screen.findByText("Report for server A");
    fireEvent.change(screen.getByRole("combobox", { name: "Inspection server" }), { target: { value: "ssh-b" } });
    expect(screen.queryByText("Report for server A")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Inspection history" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start inspection" })).not.toBeDisabled();
  });
  it("does not overwrite progress arriving before the start reply", async () => {
    let resolveStart: (run: InspectionRun) => void = () => undefined;
    vi.mocked(StartAiInspection).mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    render(<InspectionPanel locale="en" tabs={tabs} activeTabId="ssh-a" onNotify={vi.fn()} />);
    await waitFor(() => expect(ListAiInspections).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Start inspection" }));
    act(() => events.inspection?.(run("run-a", "analyzing")));
    await act(async () => resolveStart(run("run-a", "queued")));
    expect(screen.getByRole("status")).toHaveTextContent("Analyzing");
  });
});
