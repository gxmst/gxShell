import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AiPanel } from "./AiPanel";
import { GetAiConfig, GetAiUsage, ListAiInspectionEvaluationCases, ListAiInspectionEvaluations, ListAiModels, SaveAiConfig } from "../../../wailsjs/go/app/App";
import { types } from "../../../wailsjs/go/models";

vi.mock("../../../wailsjs/runtime/runtime", () => ({ EventsOn: vi.fn(() => () => undefined) }));
vi.mock("../../../wailsjs/go/app/App", () => ({
  AiChat: vi.fn(), AiContinueChat: vi.fn(), AiExecuteTools: vi.fn(), CancelAiChat: vi.fn(),
  GetAiConfig: vi.fn(), GetAiUsage: vi.fn(), ListAiModels: vi.fn(), ResetAiUsage: vi.fn(), SaveAiConfig: vi.fn(),
  ListAiInspections: vi.fn(), StartAiInspection: vi.fn(), StartAiServiceDiagnosis: vi.fn(), ExportAiInspection: vi.fn(), CancelAiInspection: vi.fn(),
  StartAiDiskDiagnosis: vi.fn(), GetAiInspection: vi.fn(), ReviewAiInspectionUnknown: vi.fn(), CompareAiInspections: vi.fn(),
  PrepareAiInspectionPlan: vi.fn(), ExecuteAiInspectionPlan: vi.fn(), DismissAiInspectionPlan: vi.fn(),
  GetAiHostDossier: vi.fn(), SaveAiHostDossier: vi.fn(), DeleteAiHostDossier: vi.fn(), FeedbackAiInspection: vi.fn(), StartAiInspectionFollowup: vi.fn(),
  ListAiInspectionEvaluationCases: vi.fn(), ListAiInspectionEvaluations: vi.fn(), StartAiInspectionEvaluation: vi.fn(), CancelAiInspectionEvaluation: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn() });
  vi.mocked(GetAiConfig).mockResolvedValue(new types.AiConfig({ provider: "anthropic", apiKey: "****", endpoint: "https://api.anthropic.com/v1", model: "claude-test" }));
  vi.mocked(GetAiUsage).mockResolvedValue(new types.AiTokenUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }));
  vi.mocked(ListAiModels).mockResolvedValue([]);
  vi.mocked(SaveAiConfig).mockResolvedValue();
});
it("opens model evaluation from AI settings instead of the inspection panel", async () => {
  vi.mocked(ListAiInspectionEvaluationCases).mockResolvedValue([{ id: "healthy_host", title: "Healthy host", description: "" }]);
  vi.mocked(ListAiInspectionEvaluations).mockResolvedValue([]);
  render(<AiPanel locale="en" onNotify={vi.fn()} getTerminalLines={() => ""} activeTabId="" tabs={[]} />);
  expect(ListAiInspectionEvaluations).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTitle("AI Settings"));
  fireEvent.click(await screen.findByRole("button", { name: "Model diagnostic evaluation" }));
  expect(await screen.findByRole("dialog", { name: "Model diagnostic evaluation" })).toBeInTheDocument();
  await screen.findByRole("checkbox", { name: "Healthy host" });
});
it("restores the native protocol and uses it when fetching models", async () => {
  render(<AiPanel locale="en" onNotify={vi.fn()} getTerminalLines={() => ""} activeTabId="" tabs={[]} />);
  await waitFor(() => expect(GetAiConfig).toHaveBeenCalled());
  fireEvent.click(screen.getByTitle("AI Settings"));
  await screen.findByDisplayValue("claude-test");
  expect(screen.getByDisplayValue("Anthropic / Claude")).toBeInTheDocument();
  fireEvent.click(screen.getByTitle("Fetch models"));
  await waitFor(() => expect(ListAiModels).toHaveBeenCalledWith("anthropic", "****", "https://api.anthropic.com/v1"));
});
