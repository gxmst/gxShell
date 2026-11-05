import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { HostDossierEditor } from "./HostDossierEditor";
import { InspectionFollowup } from "./InspectionFollowup";
import { InspectionEvaluation } from "./InspectionEvaluation";
import { InspectionReport } from "./InspectionReport";
import { GetAiHostDossier, SaveAiHostDossier, StartAiInspectionFollowup, ListAiInspectionEvaluationCases, ListAiInspectionEvaluations, StartAiInspectionEvaluation, FeedbackAiInspection } from "../../../wailsjs/go/app/App";
import type { HostDossier, InspectionRun } from "../../../wailsjs/go/workflow";

vi.mock("../../../wailsjs/go/app/App", () => ({
  GetAiHostDossier: vi.fn(), SaveAiHostDossier: vi.fn(), DeleteAiHostDossier: vi.fn(), StartAiInspectionFollowup: vi.fn(),
  ListAiInspectionEvaluationCases: vi.fn(), ListAiInspectionEvaluations: vi.fn(), StartAiInspectionEvaluation: vi.fn(), CancelAiInspectionEvaluation: vi.fn(),
  FeedbackAiInspection: vi.fn(), ReviewAiInspectionUnknown: vi.fn(), CompareAiInspections: vi.fn(), PrepareAiInspectionPlan: vi.fn(),
  ExecuteAiInspectionPlan: vi.fn(), DismissAiInspectionPlan: vi.fn(), CancelAiInspection: vi.fn(),
}));
const run = (): InspectionRun => ({
  id: "original-report", workflow: "host_inspection", sessionId: "ssh-a", profileId: "server-a", target: "Server A",
  state: "completed", step: "", createdAt: "2026-11-06T01:00:00Z", finishedAt: "2026-11-06T01:01:00Z",
  evidence: [{ id: "E6", query: { check: "ports" }, status: "collected", output: "LISTEN :8080", exitCode: 0, remoteState: "exited", truncated: false }],
  report: "# Report", rounds: 0, promptTokens: 1, completionTokens: 1, provider: "openai", model: "test", language: "zh-CN",
  document: { version: 2, verdict: "unknown", summary: "端口归属需核实。",
    checks: [{ check: "ports", status: "unknown", reading: "端口 8080 存在监听。", evidenceIds: ["E6"] }], findings: [], unknowns: [],
    analysis: { assessment: "当前风险在于监听端口的用途不明，建议先核实其归属。", insights: [{ title: "端口归属", opinion: "8080 可能承载应用，但不能仅凭监听推断具体服务。", confidence: "hypothesis", evidenceIds: ["E6"], nextCheck: "核实进程归属和对外开放预期。" }], nextSteps: ["先核实端口所属进程。"], caveats: "未验证外网访问。" } },
});
const dossier = (): HostDossier => ({ profileId: "server-a", revision: 2, purpose: "Web server", environment: "production",
  services: ["nginx.service"], ports: [443], containerRuntime: "none", notes: "No Docker", updatedAt: "2026-11-06T01:00:00Z", reviewer: "local-operator" });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(GetAiHostDossier).mockResolvedValue(dossier());
  vi.mocked(ListAiInspectionEvaluations).mockResolvedValue([]);
});

it("shows AI interpretation separately from check measurements", () => {
  render(<InspectionReport run={run()} locale="zh-CN" />);
  expect(screen.getByRole("heading", { name: "AI 分析意见" })).toBeInTheDocument();
  expect(screen.getByText("当前风险在于监听端口的用途不明，建议先核实其归属。")).toBeInTheDocument();
  expect(screen.getByText("可能原因")).toBeInTheDocument();
  expect(screen.getByRole("table")).toHaveTextContent("端口 8080 存在监听。");
});
it("pre-fills the single follow-up box from an insight instead of nesting forms", () => {
  render(<InspectionReport run={run()} locale="zh-CN" onUpdated={vi.fn()} onFollowupCreated={vi.fn()} />);
  expect(screen.getAllByRole("textbox", { name: "追问内容" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "追问这一项" }));
  const question = screen.getByRole("textbox", { name: "追问内容" }) as HTMLTextAreaElement;
  expect(question.value).toContain("请继续核实这一项");
  expect(question.value).toContain("核实进程归属");
});
it("starts a linked follow-up for the exact original report and focused evidence", async () => {
  const original = run(), created = { ...run(), id: "child", parentId: "original-report", state: "queued" };
  vi.mocked(StartAiInspectionFollowup).mockResolvedValue(created);
  const onCreated = vi.fn();
  render(<InspectionFollowup run={original} locale="zh-CN" onCreated={onCreated} onError={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "追问内容" }), { target: { value: "查一下 8080 的进程归属" } });
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "E6" } });
  fireEvent.click(screen.getByRole("button", { name: "询问 AI 并继续分析" }));
  await waitFor(() => expect(StartAiInspectionFollowup).toHaveBeenCalledWith("original-report", "查一下 8080 的进程归属", "E6"));
  expect(onCreated).toHaveBeenCalledWith(created);
  expect(original.parentId).toBeUndefined();
});
it("saves expected background with its revision and confirmed source", async () => {
  const saved = { ...dossier(), revision: 3, notes: "No Docker\n人工确认：未部署容器。" };
  vi.mocked(SaveAiHostDossier).mockResolvedValue(saved);
  render(<HostDossierEditor profileId="server-a" locale="zh-CN" onError={vi.fn()} sourceRunId="original-report" sourceUnknownId="unknown-a" suggestedNote="人工确认：未部署容器。" />);
  await screen.findByDisplayValue("Web server");
  fireEvent.change(screen.getByLabelText("预期服务（逗号分隔）"), { target: { value: "nginx.service, ssh.service" } });
  fireEvent.change(screen.getByLabelText("预期 TCP 端口（逗号分隔）"), { target: { value: "22, 443" } });
  fireEvent.click(screen.getByRole("button", { name: "保存主机档案" }));
  await waitFor(() => expect(SaveAiHostDossier).toHaveBeenCalledWith("server-a", expect.objectContaining({
    revision: 2, services: ["nginx.service", "ssh.service"], ports: [22, 443], sourceRunId: "original-report", sourceUnknownId: "unknown-a", containerRuntime: "none",
  })));
  expect(screen.getByRole("status")).toHaveTextContent("主机档案已保存");
});
it("preserves the editable draft and reports storage errors", async () => {
  vi.mocked(SaveAiHostDossier).mockRejectedValue(new Error("storage failure"));
  const onError = vi.fn();
  render(<HostDossierEditor profileId="server-a" locale="zh-CN" onError={onError} />);
  await screen.findByDisplayValue("Web server");
  fireEvent.change(screen.getByLabelText("主机用途"), { target: { value: "Updated purpose" } });
  fireEvent.click(screen.getByRole("button", { name: "保存主机档案" }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith("Error: storage failure"));
  expect(screen.getByDisplayValue("Updated purpose")).toBeInTheDocument();
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
it("records diagnostic feedback without changing the AI assessment", async () => {
  const original = run(), onUpdated = vi.fn();
  const updated = { ...original, feedback: [{ outcome: "false_alarm" as const, note: "8080 是预期的业务端口", reviewer: "operator", at: "2026-11-06T02:00:00Z" }] };
  vi.mocked(FeedbackAiInspection).mockResolvedValue(updated);
  render(<InspectionReport run={original} locale="zh-CN" onUpdated={onUpdated} onError={vi.fn()} />);
  fireEvent.change(screen.getByRole("combobox", { name: "诊断反馈" }), { target: { value: "false_alarm" } });
  fireEvent.change(screen.getByRole("textbox", { name: "说明判断正确、误报或漏报的内容" }), { target: { value: "8080 是预期的业务端口" } });
  fireEvent.click(screen.getByRole("button", { name: "保存诊断反馈" }));
  await waitFor(() => expect(FeedbackAiInspection).toHaveBeenCalledWith("original-report", "false_alarm", "8080 是预期的业务端口"));
  expect(onUpdated).toHaveBeenCalledWith(updated);
  expect(original.document?.analysis?.assessment).toContain("用途不明");
});
it("evaluates selected fixed cases with the saved model and shows raw scores", async () => {
  vi.mocked(ListAiInspectionEvaluationCases).mockResolvedValue([{ id: "disk_pressure", title: "磁盘接近满", description: "98%" }]);
  vi.mocked(StartAiInspectionEvaluation).mockResolvedValue({
    id: "evaluation-a", provider: "openai", model: "test", language: "zh-CN", state: "completed", caseVersion: 1, caseIds: ["disk_pressure"], createdAt: "2026-11-06T02:00:00Z", finishedAt: "", results: [
      { caseId: "disk_pressure", title: "磁盘接近满", passed: false, schemaValid: true, correctChecks: 6, totalChecks: 7, analysisPresent: true, expected: { disk: "critical" }, actual: { disk: "normal" }, durationMs: 100, promptTokens: 10, completionTokens: 5, rawReport: '{"checks":[]}' },
    ],
  });
  render(<InspectionEvaluation locale="zh-CN" onError={vi.fn()} />);
  await screen.findByRole("checkbox", { name: "磁盘接近满" });
  fireEvent.click(screen.getByRole("button", { name: "开始评测所选案例" }));
  await waitFor(() => expect(StartAiInspectionEvaluation).toHaveBeenCalledWith(["disk_pressure"]));
  fireEvent.click(await screen.findByText("磁盘接近满 · 待改进 · 6/7"));
  const table = screen.getByRole("table");
  expect(within(table).getByText("异常")).toBeInTheDocument();
  expect(within(table).getByText("正常")).toBeInTheDocument();
});

it("keeps a started evaluation when an older history request completes later", async () => {
  let resolveHistory!: (value: []) => void;
  vi.mocked(ListAiInspectionEvaluations).mockReturnValueOnce(new Promise((resolve) => { resolveHistory = resolve; }));
  vi.mocked(ListAiInspectionEvaluationCases).mockResolvedValue([{ id: "healthy_host", title: "正常主机", description: "正常" }]);
  vi.mocked(StartAiInspectionEvaluation).mockResolvedValue({ id: "new-evaluation", provider: "openai", model: "current-model", language: "zh-CN", state: "running", caseVersion: 1, caseIds: ["healthy_host"], createdAt: "2026-11-06T02:00:00Z", finishedAt: "", results: [] });
  render(<InspectionEvaluation locale="zh-CN" onError={vi.fn()} />);
  await screen.findByRole("checkbox", { name: "正常主机" });
  fireEvent.click(screen.getByRole("button", { name: "开始评测所选案例" }));
  await screen.findByRole("combobox", { name: "评测历史" });
  await act(async () => { resolveHistory([]); });
  expect(screen.getByRole("combobox", { name: "评测历史" })).toHaveValue("new-evaluation");
  expect(screen.getByRole("button", { name: "开始评测所选案例" })).toBeDisabled();
});
