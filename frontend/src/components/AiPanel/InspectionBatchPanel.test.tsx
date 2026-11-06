import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { InspectionBatchPanel } from "./InspectionBatchPanel";
import { InspectionStats } from "./InspectionStats";
import { StartAiInspectionBatch, ListAiInspectionBatches, CancelAiInspectionBatch, CancelAiInspection, ExportAiInspectionBatch, GetAiInspectionStats } from "../../../wailsjs/go/app/App";
import type { InspectionBatch, InspectionRun } from "../../../wailsjs/go/workflow";

const events = vi.hoisted(() => ({ update: undefined as undefined | ((run: InspectionRun) => void) }));
vi.mock("../../../wailsjs/runtime/runtime", () => ({ EventsOn: vi.fn((_event: string, callback: (run: InspectionRun) => void) => { events.update = callback; return () => undefined; }) }));
vi.mock("../../../wailsjs/go/app/App", () => ({
  StartAiInspectionBatch: vi.fn(), ListAiInspectionBatches: vi.fn(), CancelAiInspectionBatch: vi.fn(), CancelAiInspection: vi.fn(),
  GetAiInspection: vi.fn(), ExportAiInspection: vi.fn(), ExportAiInspectionBatch: vi.fn(), GetAiInspectionStats: vi.fn(),
}));
const tabs = [
  { id: "ssh-a", profileId: "a", title: "Host A", state: "connected", type: "ssh" as const },
  { id: "ssh-b", profileId: "b", title: "Host B", state: "connected", type: "ssh" as const },
  { id: "local", profileId: "", title: "Local", state: "connected", type: "local" as const, local: true },
];
const run = (id: string): InspectionRun => ({ id, batchId: "batch", workflow: "host_inspection", sessionId: "ssh-"+id, profileId: id, target: "Host "+id.toUpperCase(),
  state: "queued", step: "system", createdAt: "2026-11-06T00:00:00Z", finishedAt: "", evidence: [], report: "", rounds: 0,
  promptTokens: 0, completionTokens: 0, provider: "openai", model: "test", language: "en", revision: 0 });
const batch = (): InspectionBatch => ({ id: "batch", state: "running", concurrency: 2, createdAt: "2026-11-06T00:00:00Z", runs: [run("a"), run("b")], completed: 0, unfinished: 2, promptTokens: 0, completionTokens: 0 });
const mount = () => render(<InspectionBatchPanel locale="en" tabs={tabs} history={[]} onUpdated={vi.fn()} onNotify={vi.fn()} />);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ListAiInspectionBatches).mockResolvedValue([]);
  vi.mocked(CancelAiInspection).mockResolvedValue(true);
  vi.mocked(CancelAiInspectionBatch).mockResolvedValue(true);
});

it("starts only selected remote hosts and preserves events arriving before the start response", async () => {
  let resolve!: (value: InspectionBatch) => void;
  vi.mocked(StartAiInspectionBatch).mockImplementation(() => new Promise((done) => { resolve = done; }));
  mount();
  await waitFor(() => expect(ListAiInspectionBatches).toHaveBeenCalled());
  expect(screen.queryByRole("checkbox", { name: "Local" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start batch inspection" })).toBeDisabled();
  fireEvent.click(screen.getByRole("checkbox", { name: "Host A" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Host B" }));
  fireEvent.click(screen.getByRole("button", { name: "Start batch inspection" }));
  expect(StartAiInspectionBatch).toHaveBeenCalledWith(["ssh-a", "ssh-b"], 2);
  act(() => events.update?.({ ...run("a"), state: "completed", revision: 9, promptTokens: 100, report: "done" }));
  await act(async () => resolve(batch()));
  expect(screen.getByRole("status")).toHaveTextContent("Reports completed 1/2");
  act(() => events.update?.({ ...run("a"), state: "collecting", revision: 4 }));
  expect(screen.getByRole("status")).toHaveTextContent("Reports completed 1/2");
  expect(screen.getAllByText(/Token usage: 100/)).toHaveLength(2);
});

it("cancels a queued host separately or stops the exact batch", async () => {
  vi.mocked(ListAiInspectionBatches).mockResolvedValue([batch()]);
  mount();
  await screen.findByRole("button", { name: "Stop entire batch" });
  const hostB = screen.getByText("Host B", { selector: "strong" }).closest("article")!;
  fireEvent.click(within(hostB).getByRole("button", { name: "Stop this host" }));
  await waitFor(() => expect(CancelAiInspection).toHaveBeenCalledWith("b"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Stop entire batch" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Stop entire batch" }));
  await waitFor(() => expect(CancelAiInspectionBatch).toHaveBeenCalledWith("batch"));
});

it("keeps a failed host visible alongside a successful report and exports the completed batch", async () => {
  const finished = batch();
  finished.runs = [{ ...run("a"), state: "completed", report: "done" }, { ...run("b"), state: "partial", error: "model timeout", report: "evidence preserved", document: { version: 2, verdict: "unknown", summary: "Inspection evidence preserved.", checks: [], findings: [], unknowns: [] } }];
  vi.mocked(ListAiInspectionBatches).mockResolvedValue([finished]);
  vi.mocked(ExportAiInspectionBatch).mockResolvedValue("summary.md");
  mount();
  await screen.findByText("model timeout");
  expect(screen.getByRole("status")).toHaveTextContent("Reports completed 1/2");
  expect(screen.getAllByRole("button", { name: "View full report" })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Export summary MD" }));
  await waitFor(() => expect(ExportAiInspectionBatch).toHaveBeenCalledWith("batch"));
});

it("filters statistics by workflow version and batch without merging historical results", async () => {
  const row = { provider: "openai", model: "test", runs: 1, stopped: 0, clean: 1, corrected: 0, failed: 0, noReport: 0, falseAlarms: 0, missedIssues: 0, avgTokens: 100, avgDurationMs: 1000, completed: 1 };
  vi.mocked(GetAiInspectionStats).mockResolvedValue([{ ...row, model: "old-model" }, { ...row, model: "new-model", workflowVersion: "inspection-v4", batchId: "batch" }]);
  render(<InspectionStats locale="en" onError={vi.fn()} />);
  await screen.findByRole("combobox", { name: "Workflow version" });
  fireEvent.change(screen.getByRole("combobox", { name: "Workflow version" }), { target: { value: "inspection-v4" } });
  expect(screen.queryByText("old-model")).not.toBeInTheDocument();
  expect(screen.getByText("new-model")).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Batch" }), { target: { value: "single" } });
  expect(screen.queryByText("new-model")).not.toBeInTheDocument();
});
