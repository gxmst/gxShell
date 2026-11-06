import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { AiPanel } from "./AiPanel";
import { AiChat, AiContinueChat, AiExecuteTools, GetAiConfig, GetAiUsage } from "../../../wailsjs/go/app/App";
import { types } from "../../../wailsjs/go/models";
import { EventsOn } from "../../../wailsjs/runtime/runtime";

vi.mock("../../../wailsjs/runtime/runtime", () => ({ EventsOn: vi.fn(() => () => undefined) }));
vi.mock("../../../wailsjs/go/app/App", () => ({
  AiChat: vi.fn(), AiContinueChat: vi.fn(), AiExecuteTools: vi.fn(), CancelAiChat: vi.fn(),
  GetAiConfig: vi.fn(), GetAiUsage: vi.fn(), ListAiModels: vi.fn(), ResetAiUsage: vi.fn(), SaveAiConfig: vi.fn(),
}));

const tab = { id: "ssh-a", profileId: "server-a", title: "Server A", state: "connected" };
const storedChat = (toolResult: Record<string, unknown>) => JSON.stringify([{
  id: "chat-a", title: "Chat", createdAt: 1, terminalSessionId: "ssh-a", terminalTitle: "Server A",
  messages: [
    { role: "user", content: "clean the build directory" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", type: "function", function: { name: "execute_command", arguments: "{\"command\":\"rm -rf build\"}" } }],
      toolResults: [{ toolCallId: "call-1", content: "", executing: false, executed: false, ...toolResult }] },
  ],
}]);
const mountWith = (chats: string) => {
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => key === "gx:ai-sessions" ? chats : key === "gx:ai-active-session" ? "chat-a" : null),
    setItem: vi.fn(), removeItem: vi.fn(), clear: vi.fn(),
  });
  render(<AiPanel locale="en" onNotify={vi.fn()} getTerminalLines={() => ""} activeTabId="ssh-a" tabs={[tab as never]} />);
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(GetAiConfig).mockResolvedValue(new types.AiConfig({ provider: "openai", apiKey: "****", endpoint: "", model: "test" }));
  vi.mocked(GetAiUsage).mockResolvedValue(new types.AiTokenUsage({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }));
  vi.mocked(AiContinueChat).mockResolvedValue();
  vi.mocked(AiChat).mockResolvedValue();
});

it("sends a rejection with its reason back to the model without running the tool", async () => {
  mountWith(storedChat({}));
  fireEvent.click(await screen.findByRole("button", { name: /Reject/ }));
  fireEvent.change(screen.getByRole("textbox", { name: /Reason/ }), { target: { value: "keep the build cache" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm rejection" }));
  await waitFor(() => expect(AiContinueChat).toHaveBeenCalledTimes(1));
  expect(AiExecuteTools).not.toHaveBeenCalled();
  const request = vi.mocked(AiContinueChat).mock.calls[0][0];
  const toolMessage = request.messages.find((message) => message.role === "tool");
  expect(toolMessage?.toolCallId).toBe("call-1");
  expect(toolMessage?.content).toContain("REJECTED");
  expect(toolMessage?.content).toContain("keep the build cache");
  expect(screen.getByText(/Rejected/)).toBeInTheDocument();
});

it("recovers a tool left running by a reload instead of blocking the chat", async () => {
  mountWith(storedChat({ executing: true }));
  const input = await screen.findByRole("textbox");
  expect(input).not.toBeDisabled();
  expect(screen.getByText(/INTERRUPTED/)).toBeInTheDocument();
  // The unknown result is recorded, but nothing is sent until the user writes.
  expect(AiContinueChat).not.toHaveBeenCalled();
});

it("shows the input size the provider reported for the latest request", async () => {
  const handlers: Record<string, (data: unknown) => void> = {};
  vi.mocked(EventsOn).mockImplementation(((name: string, handler: (data: unknown) => void) => { handlers[name] = handler; return () => undefined; }) as never);
  vi.mocked(GetAiUsage).mockResolvedValue(new types.AiTokenUsage({ promptTokens: 12000, completionTokens: 300, totalTokens: 12300 }));
  mountWith(JSON.stringify([{ id: "chat-a", title: "Chat", createdAt: 1, terminalSessionId: "ssh-a", terminalTitle: "Server A", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "Hello." }] }]));
  fireEvent.change(await screen.findByRole("textbox"), { target: { value: "and the cache?" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
  await waitFor(() => expect(AiChat).toHaveBeenCalledTimes(1));
  const { chatId, requestId } = vi.mocked(AiChat).mock.calls[0][0];
  act(() => handlers["ai:chunk"]({ chatId, requestId, content: "Done.", finish: true, promptTokens: 12000 }));
  expect(await screen.findByText("Last input: 12,000")).toBeInTheDocument();
});
