import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, History, Link2, ListChecks, MessageSquarePlus, Play, RefreshCw, Send, Server, Settings2, Square, Stethoscope, X } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { types } from "../../../wailsjs/go/models";
import { AiChat, AiContinueChat, AiExecuteTools, CancelAiChat, GetAiConfig, GetAiUsage, ListAiModels, ResetAiUsage, SaveAiConfig } from "../../../wailsjs/go/app/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import { t } from "../../i18n";
import type { Tab, Toast } from "../../types";
import { Label } from "../modals/ModalShell";

type ToolCallData = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type ToolResultData = {
  toolCallId: string;
  content: string;
  executing: boolean;
  executed: boolean;
};

type ChatMsg = {
  role: "user" | "assistant" | "tool";
  content: string;
  reasoningContent?: string;
  toolCalls?: ToolCallData[];
  toolCallId?: string;
  toolResults?: ToolResultData[];
  toolContinued?: boolean;
};

type ChatSession = {
  id: string;
  title: string;
  messages: ChatMsg[];
  createdAt: number;
  terminalSessionId?: string;
  terminalTitle?: string;
};

type AiStreamEvent = {
  chatId?: string;
  requestId?: string;
  content?: string;
  reasoningContent?: string;
  finish?: boolean;
  cancelled?: boolean;
  error?: string;
  toolCalls?: ToolCallData[];
};

type BufferedAiEvent = {
  chatId: string;
  requestId: string;
  content: string;
  reasoningContent: string;
  finish: boolean;
  cancelled: boolean;
  error: string;
  toolCalls?: ToolCallData[];
};

let sessionCounter = 0;

marked.setOptions({ breaks: true, gfm: true });

const MarkdownContent = memo(function MarkdownContent({ content }: { content: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content) as string), [content]);
  return <div className="ai-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
});

function isConnectedRemote(tab?: Tab): tab is Tab {
  return !!tab && tab.state === "connected" && !tab.local && tab.type !== "markdown";
}

function requestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `ai-req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toApiMessages(messages: ChatMsg[]): types.AiMessage[] {
  const result: types.AiMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    if (message.role === "assistant" && !message.content && !message.toolCalls?.length) continue;

    const apiMessage = new types.AiMessage({
      role: message.role,
      content: message.content,
      reasoningContent: message.reasoningContent || "",
      toolCallId: message.toolCallId || "",
    });
    if (message.toolCalls?.length) {
      apiMessage.toolCalls = message.toolCalls.map((toolCall) => new types.AiToolCall({
        id: toolCall.id,
        type: toolCall.type,
        function: new types.AiFunctionCall({
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }),
      }));
    }
    result.push(apiMessage);

    if (message.role === "assistant" && message.toolResults?.length && message.toolResults.every((item) => item.executed)) {
      for (const toolResult of message.toolResults) {
        result.push(new types.AiMessage({
          role: "tool",
          content: toolResult.content,
          toolCallId: toolResult.toolCallId,
        }));
      }
    }
  }
  return result;
}

function ToolCallBlock({ tc, result, onApprove, lang, disabled, disabledHint, targetLabel }: {
  tc: ToolCallData;
  result?: ToolResultData;
  onApprove: () => void;
  lang: string;
  disabled: boolean;
  disabledHint: string;
  targetLabel: string;
}) {
  let args: any = {};
  try { args = JSON.parse(tc.function.arguments); } catch {}

  const isCommand = tc.function.name === "execute_command";
  const isReadFile = tc.function.name === "read_file";
  const cmdText = isCommand ? args.command : isReadFile ? `cat ${args.path}` : tc.function.arguments;

  return (
    <div className="ai-tool-call">
      <div className="ai-tool-call-header">
        <Play size={10} className="text-accent" />
        <span className="text-[10px] font-semibold">{isCommand ? t(lang, "aiToolExecute") : isReadFile ? t(lang, "aiToolReadFile") : tc.function.name}</span>
        <span className="ai-tool-target" title={targetLabel}>@ {targetLabel}</span>
      </div>
      <code className="ai-tool-call-cmd">{cmdText}</code>
      {result?.executed && (
        <pre className="ai-tool-call-result">{result.content.length > 2000 ? result.content.slice(0, 2000) + "\n... (truncated)" : result.content}</pre>
      )}
      {result?.executing && <div className="ai-tool-call-status">{t(lang, "aiToolRunning")}</div>}
      {!result?.executed && !result?.executing && (
        <div className="ai-tool-call-actions">
          <button className="ai-tool-approve-btn" onClick={onApprove} disabled={disabled} title={disabled ? disabledHint : undefined}>
            <Check size={10} /> {t(lang, "aiRunTool")}
          </button>
          {disabled && <span className="ai-tool-disabled-hint">{disabledHint}</span>}
        </div>
      )}
    </div>
  );
}

export function AiPanel(props: {
  locale: string;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
  getTerminalLines: (id: string, lineCount: number) => string;
  activeTabId: string;
  tabs: Tab[];
}) {
  const lang = props.locale;
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    try {
      const stored = localStorage.getItem("gx:ai-sessions");
      if (stored) {
        const parsed = JSON.parse(stored) as ChatSession[];
        return parsed.map((session) => {
          const messages = [...(session.messages || [])];
          const last = messages[messages.length - 1];
          if (last?.role === "assistant" && !last.content && !last.toolCalls?.length) messages.pop();
          return { ...session, messages };
        });
      }
    } catch {}
    return [];
  });
  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    try { return localStorage.getItem("gx:ai-active-session") || ""; } catch { return ""; }
  });
  const [input, setInput] = useState("");
  const [streamingByChat, setStreamingByChat] = useState<Record<string, string>>({});
  const [usage, setUsage] = useState<types.AiTokenUsage | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [modelList, setModelList] = useState<string[]>([]);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [showSessionList, setShowSessionList] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sessionsRef = useRef(sessions);
  const tabsRef = useRef(props.tabs);
  const activeRequestsRef = useRef<Record<string, string>>({});
  const eventBufferRef = useRef<Map<string, BufferedAiEvent>>(new Map());
  const eventTimerRef = useRef<number | null>(null);
  sessionsRef.current = sessions;
  tabsRef.current = props.tabs;

  const activeSession = sessions.find((session) => session.id === activeSessionId);
  const messages = activeSession?.messages || [];
  const boundTerminal = props.tabs.find((tab) => tab.id === activeSession?.terminalSessionId);
  const boundTerminalSessionId = activeSession?.terminalSessionId || "";
  const targetConnected = isConnectedRemote(boundTerminal);
  const activeStreaming = !!streamingByChat[activeSessionId];
  const activeHasPendingTools = messages.some((message) => message.toolResults?.some((result) => !result.executed));
  const activeHasExecutingTools = messages.some((message) => message.toolResults?.some((result) => result.executing));
  const activeHasUncontinuedTools = messages.some((message) => !!message.toolResults?.length && !message.toolContinued);
  const activeBindableTerminal = props.tabs.find((tab) => tab.id === props.activeTabId && isConnectedRemote(tab));

  const MAX_STORED_SESSIONS = 20;
  const MAX_MSG_LENGTH = 8000;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const trimmed = sessions.slice(0, MAX_STORED_SESSIONS).map((session) => ({
          ...session,
          messages: session.messages.map((message) => ({
            ...message,
            content: message.content.length > MAX_MSG_LENGTH ? message.content.slice(0, MAX_MSG_LENGTH) + "..." : message.content,
            reasoningContent: message.reasoningContent && message.reasoningContent.length > MAX_MSG_LENGTH
              ? message.reasoningContent.slice(0, MAX_MSG_LENGTH) + "..."
              : message.reasoningContent,
            toolResults: message.toolResults?.map((result) => ({
              ...result,
              content: result.content.length > MAX_MSG_LENGTH ? result.content.slice(0, MAX_MSG_LENGTH) + "..." : result.content,
            })),
          })),
        }));
        localStorage.setItem("gx:ai-sessions", JSON.stringify(trimmed));
      } catch {}
    }, 400);
    return () => window.clearTimeout(timer);
  }, [sessions]);

  useEffect(() => {
    try { localStorage.setItem("gx:ai-active-session", activeSessionId); } catch {}
  }, [activeSessionId]);

  useEffect(() => { GetAiUsage().then(setUsage).catch(() => {}); }, []);

  useEffect(() => {
    GetAiConfig().then((cfg: any) => {
      setApiKey(cfg.apiKey || "");
      setEndpoint(cfg.endpoint || "");
      setModel(cfg.model || "");
    }).catch(() => {});
  }, []);

  const loadSettings = useCallback(() => {
    GetAiConfig().then((cfg: any) => {
      setApiKey(cfg.apiKey || "");
      setEndpoint(cfg.endpoint || "");
      setModel(cfg.model || "");
    }).catch(() => {});
  }, []);

  const onNotifyRef = useRef(props.onNotify);
  onNotifyRef.current = props.onNotify;

  const flushBufferedEvents = useCallback(() => {
    eventTimerRef.current = null;
    const buffered = Array.from(eventBufferRef.current.values());
    eventBufferRef.current.clear();
    if (buffered.length === 0) return;

    setSessions((previous) => previous.map((session) => {
      const events = buffered.filter((event) => event.chatId === session.id);
      if (events.length === 0) return session;
      let nextMessages = [...session.messages];
      for (const event of events) {
        const lastIndex = nextMessages.length - 1;
        const last = nextMessages[lastIndex];
        if (last?.role === "assistant") {
          const updated: ChatMsg = {
            ...last,
            content: last.content + event.content,
            reasoningContent: (last.reasoningContent || "") + event.reasoningContent,
          };
          if (event.toolCalls?.length && event.finish) {
            updated.toolCalls = event.toolCalls;
            updated.toolResults = event.toolCalls.map((toolCall) => ({
              toolCallId: toolCall.id,
              content: "",
              executing: false,
              executed: false,
            }));
          }
          nextMessages[lastIndex] = updated;
        }
        const updatedLast = nextMessages[nextMessages.length - 1];
        if ((event.error || event.cancelled) && updatedLast?.role === "assistant" && !updatedLast.content && !updatedLast.toolCalls?.length) {
          nextMessages = nextMessages.slice(0, -1);
        }
      }
      return { ...session, messages: nextMessages };
    }));

    const completedChats = new Set<string>();
    for (const event of buffered) {
      if (!event.finish && !event.error && !event.cancelled) continue;
      if (activeRequestsRef.current[event.chatId] !== event.requestId) continue;
      delete activeRequestsRef.current[event.chatId];
      completedChats.add(event.chatId);
      if (event.error && !event.cancelled) onNotifyRef.current(event.error, "error");
    }
    if (completedChats.size > 0) {
      setStreamingByChat((previous) => {
        const next = { ...previous };
        completedChats.forEach((chatId) => delete next[chatId]);
        return next;
      });
      GetAiUsage().then(setUsage).catch(() => {});
    }
  }, []);

  const enqueueStreamEvent = useCallback((data: AiStreamEvent) => {
    const chatId = data.chatId || "";
    const currentRequestId = data.requestId || "";
    if (!chatId || !currentRequestId || activeRequestsRef.current[chatId] !== currentRequestId) return;
    const key = `${chatId}\u0000${currentRequestId}`;
    const existing = eventBufferRef.current.get(key) || {
      chatId,
      requestId: currentRequestId,
      content: "",
      reasoningContent: "",
      finish: false,
      cancelled: false,
      error: "",
    };
    existing.content += data.content || "";
    existing.reasoningContent += data.reasoningContent || "";
    existing.finish = existing.finish || !!data.finish;
    existing.cancelled = existing.cancelled || !!data.cancelled;
    existing.error = existing.error || data.error || "";
    if (data.toolCalls?.length) existing.toolCalls = data.toolCalls;
    eventBufferRef.current.set(key, existing);
    if (eventTimerRef.current === null) {
      eventTimerRef.current = window.setTimeout(flushBufferedEvents, 75);
    }
  }, [flushBufferedEvents]);

  useEffect(() => {
    const offChunk = EventsOn("ai:chunk", (data: AiStreamEvent) => enqueueStreamEvent(data));
    const offError = EventsOn("ai:error", (data: AiStreamEvent) => enqueueStreamEvent(data));
    return () => {
      offChunk();
      offError();
      if (eventTimerRef.current !== null) window.clearTimeout(eventTimerRef.current);
      eventTimerRef.current = null;
    };
  }, [enqueueStreamEvent]);

  const launchAiRequest = useCallback((session: ChatSession, apiMessages: types.AiMessage[], terminalContext: string, continuing: boolean) => {
    const currentRequestId = requestId();
    const target = tabsRef.current.find((tab) => tab.id === session.terminalSessionId);
    const toolsEnabled = isConnectedRemote(target);
    activeRequestsRef.current[session.id] = currentRequestId;
    setStreamingByChat((previous) => ({ ...previous, [session.id]: currentRequestId }));

    const request = new types.AiChatRequest({
      messages: apiMessages,
      context: terminalContext,
      sessionId: toolsEnabled ? session.terminalSessionId || "" : "",
      chatId: session.id,
      requestId: currentRequestId,
      enableTools: toolsEnabled,
    });
    const invoke = continuing ? AiContinueChat : AiChat;
    invoke(request).catch((error) => enqueueStreamEvent({
      chatId: session.id,
      requestId: currentRequestId,
      finish: true,
      error: `${continuing ? "Continue chat" : "Chat"} failed: ${String(error)}`,
    }));
    return currentRequestId;
  }, [enqueueStreamEvent]);

  const executeToolsAndContinue = useCallback(async (chatId: string, toolCalls: ToolCallData[]) => {
    const toolCallIds = toolCalls.map((toolCall) => toolCall.id).filter(Boolean);
    if (toolCallIds.length === 0) return;
    const session = sessionsRef.current.find((item) => item.id === chatId);
    const target = tabsRef.current.find((tab) => tab.id === session?.terminalSessionId);
    if (!session || !isConnectedRemote(target)) {
      onNotifyRef.current(t(lang, "aiTargetDisconnected"), "error");
      return;
    }

    setSessions((previous) => previous.map((item) => item.id !== chatId ? item : {
      ...item,
      messages: item.messages.map((message) => !message.toolResults?.some((result) => toolCallIds.includes(result.toolCallId)) ? message : {
        ...message,
        toolResults: message.toolResults.map((result) => toolCallIds.includes(result.toolCallId) ? { ...result, executing: true } : result),
      }),
    }));

    try {
      const outputs = await AiExecuteTools(target.id, toolCallIds);
      setSessions((previous) => previous.map((item) => item.id !== chatId ? item : {
        ...item,
        messages: item.messages.map((message) => !message.toolResults?.some((result) => toolCallIds.includes(result.toolCallId)) ? message : {
          ...message,
          toolResults: message.toolResults.map((result) => toolCallIds.includes(result.toolCallId) ? {
            ...result,
            content: outputs?.[result.toolCallId] || "Error: missing tool result",
            executing: false,
            executed: true,
          } : result),
        }),
      }));
    } catch (error) {
      onNotifyRef.current("Tool execution failed: " + String(error), "error");
      setSessions((previous) => previous.map((item) => item.id !== chatId ? item : {
        ...item,
        messages: item.messages.map((message) => !message.toolResults?.some((result) => toolCallIds.includes(result.toolCallId)) ? message : {
          ...message,
          toolResults: message.toolResults.map((result) => toolCallIds.includes(result.toolCallId) ? {
            ...result,
            content: "Error: " + String(error),
            executing: false,
            executed: true,
          } : result),
        }),
      }));
    }
  }, [lang]);

  useEffect(() => {
    for (const session of sessions) {
      if (activeRequestsRef.current[session.id]) continue;
      let toolMessageIndex = -1;
      for (let index = session.messages.length - 1; index >= 0; index -= 1) {
        const message = session.messages[index];
        if (message.role !== "assistant" || !message.toolResults?.length || message.toolContinued) continue;
        if (!message.toolResults.every((result) => result.executed) || message.toolResults.some((result) => result.executing)) continue;
        toolMessageIndex = index;
        break;
      }
      if (toolMessageIndex < 0) continue;

      const apiMessages = toApiMessages(session.messages);
      setSessions((previous) => previous.map((item) => {
        if (item.id !== session.id) return item;
        const nextMessages = item.messages.map((message, index) => index === toolMessageIndex ? { ...message, toolContinued: true } : message);
        return { ...item, messages: [...nextMessages, { role: "assistant", content: "" }] };
      }));
      let terminalContext = "";
      if (session.terminalSessionId) {
        try { terminalContext = props.getTerminalLines(session.terminalSessionId, 10); } catch {}
      }
      launchAiRequest(session, apiMessages, terminalContext, true);
    }
  }, [sessions, launchAiRequest, props.getTerminalLines]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const newSession = useCallback(() => {
    const id = "ai-sess-" + Date.now() + "-" + (++sessionCounter);
    const candidate = tabsRef.current.find((tab) => tab.id === props.activeTabId && isConnectedRemote(tab));
    const session: ChatSession = {
      id,
      title: t(lang, "aiNewChat") + " " + (sessionsRef.current.length + 1),
      messages: [],
      createdAt: Date.now(),
      terminalSessionId: candidate?.id,
      terminalTitle: candidate?.title,
    };
    setSessions((previous) => [session, ...previous]);
    setActiveSessionId(id);
    setInput("");
  }, [lang, props.activeTabId]);

  useEffect(() => {
    if (sessions.length === 0 && !activeSessionId) {
      newSession();
    } else if (sessions.length > 0 && !sessions.some((session) => session.id === activeSessionId)) {
      setActiveSessionId(sessions[0].id);
    }
  }, [sessions, activeSessionId, newSession]);

  const switchSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setShowSessionList(false);
  }, []);

  const deleteSession = useCallback((id: string) => {
    const currentRequestId = activeRequestsRef.current[id];
    if (currentRequestId) CancelAiChat(id, currentRequestId).catch(() => {});
    setSessions((previous) => previous.filter((session) => session.id !== id));
    setActiveSessionId((current) => {
      if (current !== id) return current;
      const remaining = sessionsRef.current.filter((session) => session.id !== id);
      return remaining[0]?.id || "";
    });
  }, []);

  const saveSettings = useCallback(async () => {
    try {
      await SaveAiConfig("openai", apiKey, endpoint, model);
      setShowSettings(false);
      onNotifyRef.current(t(lang, "aiSettingsSaved"), "success");
    } catch (error) {
      onNotifyRef.current("Save failed: " + String(error), "error");
    }
  }, [apiKey, endpoint, model, lang]);

  const fetchModels = useCallback(async () => {
    setFetchingModels(true);
    try {
      const models = await ListAiModels("openai", apiKey, endpoint);
      setModelList(models || []);
      if (!models || models.length === 0) onNotifyRef.current(t(lang, "aiNoModels"), "info");
    } catch (error) {
      onNotifyRef.current(String(error), "error");
    } finally {
      setFetchingModels(false);
    }
  }, [apiKey, endpoint, lang]);

  const sendChat = useCallback((userText: string, explicitContext?: string) => {
    const text = userText.trim();
    const session = sessionsRef.current.find((item) => item.id === activeSessionId);
    if (!text || !session || activeRequestsRef.current[session.id]) return;
    if (!model) {
      onNotifyRef.current(t(lang, "aiNotConfigured"), "error");
      return;
    }

    let terminalContext = explicitContext || "";
    if (explicitContext === undefined && session.terminalSessionId) {
      try { terminalContext = props.getTerminalLines(session.terminalSessionId, 10); } catch {}
    }
    const userMessage: ChatMsg = { role: "user", content: text };
    const assistantMessage: ChatMsg = { role: "assistant", content: "" };
    const nextMessages = [...session.messages, userMessage];
    const updatedSession: ChatSession = {
      ...session,
      title: session.messages.length === 0 ? text.slice(0, 30) + (text.length > 30 ? "..." : "") : session.title,
      messages: [...nextMessages, assistantMessage],
    };
    setSessions((previous) => previous.map((item) => item.id === session.id ? updatedSession : item));
    setInput("");
    launchAiRequest(updatedSession, toApiMessages(nextMessages), terminalContext, false);
  }, [activeSessionId, model, lang, props.getTerminalLines, launchAiRequest]);

  const send = useCallback(() => sendChat(input), [input, sendChat]);

  const diagnose = useCallback(() => {
    if (activeStreaming) return;
    let terminalContext = "";
    if (boundTerminalSessionId) {
      try { terminalContext = props.getTerminalLines(boundTerminalSessionId, 30); } catch {}
    }
    const prompt = terminalContext
      ? t(lang, "aiDiagnose")
      : t(lang, "aiDiagnose") + " (" + t(lang, "aiNoTerminalOutput") + ")";
    sendChat(prompt, terminalContext);
  }, [activeStreaming, boundTerminalSessionId, props.getTerminalLines, lang, sendChat]);

  const cancelStreaming = useCallback(() => {
    const currentRequestId = activeRequestsRef.current[activeSessionId];
    if (!activeSessionId || !currentRequestId) return;
    CancelAiChat(activeSessionId, currentRequestId).then((cancelled) => {
      if (!cancelled && activeRequestsRef.current[activeSessionId] === currentRequestId) {
        enqueueStreamEvent({ chatId: activeSessionId, requestId: currentRequestId, finish: true, cancelled: true });
      }
    }).catch((error) => enqueueStreamEvent({
      chatId: activeSessionId,
      requestId: currentRequestId,
      finish: true,
      error: "Cancel failed: " + String(error),
    }));
  }, [activeSessionId, enqueueStreamEvent]);

  const rebindTarget = useCallback(() => {
    const target = tabsRef.current.find((tab) => tab.id === props.activeTabId && isConnectedRemote(tab));
    if (!target) {
      onNotifyRef.current(t(lang, "aiNoConnectedTarget"), "error");
      return;
    }
    setSessions((previous) => previous.map((session) => {
      if (session.id !== activeSessionId) return session;
      return {
        ...session,
        terminalSessionId: target.id,
        terminalTitle: target.title,
        // Tool authorizations are scoped to the old terminal. Treat any calls
        // that were not started as blocked so the conversation can continue
        // against the newly bound target without ever running them there.
        messages: session.messages.map((message) => !message.toolResults?.some((result) => !result.executed) ? message : {
          ...message,
          toolResults: message.toolResults.map((result) => result.executed ? result : {
            ...result,
            content: "BLOCKED: terminal target changed before execution",
            executing: false,
            executed: true,
          }),
        }),
      };
    }));
  }, [activeSessionId, props.activeTabId, lang]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  let terminalContextReady = false;
  if (boundTerminalSessionId) {
    try { terminalContextReady = !!props.getTerminalLines(boundTerminalSessionId, 1); } catch {}
  }
  const assistantStatus = model
    ? `${model} · ${apiKey ? (terminalContextReady ? t(lang, "aiContextReady") : t(lang, "aiNoContext")) : t(lang, "aiNoApiKey")}`
    : t(lang, "aiNotConfigured");
  const assistantReady = !!model && !!apiKey;
  const targetLabel = boundTerminal?.title || activeSession?.terminalTitle || boundTerminalSessionId || t(lang, "aiNoTarget");
  const targetState = targetConnected ? t(lang, "aiTargetConnected") : boundTerminalSessionId ? t(lang, "aiTargetDisconnected") : t(lang, "aiNoTarget");
  const targetLocked = activeStreaming || activeHasExecutingTools;
  const canRebindTarget = !!activeBindableTerminal && activeBindableTerminal.id !== boundTerminalSessionId && !targetLocked;

  return (
    <div className="ai-panel" style={{ position: "relative" }}>
      <div className="ai-header">
        <div className="ai-header-heading">
          <span className={`ai-header-state ${assistantReady ? "ready" : ""}`} />
          <span className="ai-header-copy">
            <strong>{activeSession?.title || t(lang, "aiAssistant")}</strong>
            <small>{assistantStatus}</small>
          </span>
        </div>
        <div className="panel-page-actions">
          <button className="panel-page-action" onClick={newSession} title={t(lang, "aiNewChat")}><MessageSquarePlus size={11} /></button>
          <button className={`panel-page-action ${showSessionList ? "active" : ""}`} onClick={() => setShowSessionList((value) => !value)} title={t(lang, "aiChatHistory")}><History size={11} /></button>
          <button className={`panel-page-action ${showSettings ? "active" : ""}`} onClick={() => { setShowSettings((value) => !value); if (!showSettings) loadSettings(); }} title={t(lang, "aiSettings")}><Settings2 size={11} /></button>
          <button className="panel-page-action panel-page-action-primary" onClick={diagnose} disabled={activeStreaming} title={t(lang, "aiDiagnose")}><Stethoscope size={11} /></button>
        </div>
      </div>

      <div className={`ai-target-bar ${targetConnected ? "connected" : "disconnected"}`}>
        <Server size={11} />
        <span className="ai-target-copy" title={targetLabel}>{t(lang, "aiTarget")}: <strong>{targetLabel}</strong> · {targetState}</span>
        <button className="mini-btn" onClick={rebindTarget} disabled={!canRebindTarget} title={targetLocked ? t(lang, "aiTargetLocked") : t(lang, "aiBindActiveTarget")}>
          <Link2 size={10} />
        </button>
      </div>

      {showSessionList && (
        <div className="ai-settings-popup">
          <div className="ai-settings-popup-header">
            <span className="text-[11px] font-semibold text-accent">{t(lang, "aiChatHistory")}</span>
            <button className="mini-btn" onClick={() => setShowSessionList(false)}><X size={10} /></button>
          </div>
          <div className="ai-session-list">
            {sessions.length === 0 && <div className="text-[10px] text-muted p-2">{t(lang, "aiNoChats")}</div>}
            {sessions.map((session) => (
              <div key={session.id} className={`ai-session-item ${session.id === activeSessionId ? "active" : ""}`} onClick={() => switchSession(session.id)}>
                <span className="ai-session-title truncate">{streamingByChat[session.id] ? "● " : ""}{session.title}</span>
                <button className="mini-btn text-[9px] opacity-40 hover:opacity-100" onClick={(event) => { event.stopPropagation(); deleteSession(session.id); }}><X size={8} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      {showSettings && (
        <div className="ai-settings-popup">
          <div className="ai-settings-popup-header">
            <span className="text-[11px] font-semibold text-accent">{t(lang, "aiSettings")}</span>
            <button className="mini-btn" onClick={() => setShowSettings(false)}><X size={10} /></button>
          </div>
          <div className="ai-settings-popup-body">
            <Label text={t(lang, "aiPreset")}>
              <select className="input compact-input" value={endpoint === "https://api.deepseek.com/v1" ? "deepseek" : "custom"} onChange={(event) => {
                if (event.target.value === "deepseek") {
                  setEndpoint("https://api.deepseek.com/v1");
                  setModel("deepseek-chat");
                } else {
                  setEndpoint("");
                  setModel("");
                }
                setModelList([]);
              }}>
                <option value="custom">{t(lang, "aiOpenAICompatible")}</option>
                <option value="deepseek">DeepSeek</option>
              </select>
            </Label>
            <Label text={t(lang, "aiApiKey")}><input className="input compact-input" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-..." /></Label>
            <Label text={t(lang, "aiEndpoint")}><input className="input compact-input" value={endpoint} onChange={(event) => { setEndpoint(event.target.value); setModelList([]); }} placeholder="https://api.openai.com/v1" /></Label>
            <Label text={t(lang, "aiModel")}>
              <div className="flex gap-1 items-center">
                {modelList.length > 0 ? (
                  <select className="input compact-input flex-1" value={model} onChange={(event) => setModel(event.target.value)}>
                    <option value="">{t(lang, "aiSelectModel")}</option>
                    {modelList.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                ) : (
                  <input className="input compact-input flex-1" value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4o / deepseek-chat" />
                )}
                <button className={`mini-btn ${fetchingModels ? "animate-spin" : ""}`} onClick={fetchModels} disabled={fetchingModels} title={t(lang, "aiFetchModels")}><RefreshCw size={10} /></button>
              </div>
            </Label>
            <button className="btn-primary w-full text-[10px] mt-1" onClick={saveSettings}>{t(lang, "save")}</button>
          </div>
        </div>
      )}

      <div className="ai-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-empty">
            <Bot size={28} className="text-muted mb-2" />
            <div className="text-[11px] text-muted">{t(lang, "aiInputPlaceholder")}</div>
          </div>
        )}
        {messages.map((message, index) => {
          const messageStreaming = activeStreaming && index === messages.length - 1 && message.role === "assistant";
          return (
            <div key={index} className={message.role === "user" ? "ai-msg-user" : message.role === "tool" ? "ai-msg-tool" : "ai-msg-assistant"}>
              {message.role === "assistant" && <Bot size={12} className="ai-msg-icon" />}
              <div className="ai-msg-content">
                {message.role === "assistant" && message.content ? (
                  messageStreaming ? <span className="ai-stream-text">{message.content}</span> : <MarkdownContent content={message.content} />
                ) : message.role === "assistant" && messageStreaming && !message.content ? (
                  <span className="ai-typing-indicator"><span /><span /><span /></span>
                ) : message.role === "assistant" && !message.content && !message.toolCalls ? null : message.role === "user" ? message.content : ""}

                {message.toolCalls && (() => {
                  const pending = message.toolCalls.filter((toolCall) => {
                    const result = message.toolResults?.find((item) => item.toolCallId === toolCall.id);
                    return !result?.executed && !result?.executing;
                  });
                  return (
                    <>
                      {pending.length > 1 && (
                        <div className="ai-tool-call-bulk">
                          <button className="ai-tool-approve-btn" disabled={!targetConnected} title={!targetConnected ? t(lang, "aiTargetDisconnected") : undefined} onClick={() => activeSession && executeToolsAndContinue(activeSession.id, pending)}>
                            <ListChecks size={10} /> {t(lang, "aiRunAllTools")} ({pending.length})
                          </button>
                        </div>
                      )}
                      {message.toolCalls.map((toolCall, toolIndex) => (
                        <ToolCallBlock
                          key={toolCall.id || toolIndex}
                          tc={toolCall}
                          result={message.toolResults?.find((item) => item.toolCallId === toolCall.id)}
                          onApprove={() => activeSession && executeToolsAndContinue(activeSession.id, [toolCall])}
                          lang={lang}
                          disabled={!targetConnected}
                          disabledHint={t(lang, "aiTargetDisconnected")}
                          targetLabel={targetLabel}
                        />
                      ))}
                    </>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>

      {usage && usage.totalTokens > 0 && (
        <div className="ai-usage">
          <span>{t(lang, "aiTokenUsage")}: {usage.totalTokens.toLocaleString()}</span>
          <button className="text-[9px] opacity-60 hover:opacity-100" onClick={() => { ResetAiUsage(); setUsage(new types.AiTokenUsage()); }}>{t(lang, "aiResetUsage")}</button>
        </div>
      )}

      <div className="ai-input-row">
        <textarea
          ref={inputRef}
          className="ai-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={activeHasPendingTools ? t(lang, "aiResolveToolsFirst") : activeHasUncontinuedTools ? t(lang, "aiThinking") : t(lang, "aiInputPlaceholder")}
          rows={2}
          disabled={activeStreaming || activeHasUncontinuedTools}
        />
        {activeStreaming ? (
          <button className="ai-send-btn ai-stop-btn" onClick={cancelStreaming} title={t(lang, "aiStop")}><Square size={12} /></button>
        ) : (
          <button className="ai-send-btn" onClick={send} disabled={activeHasUncontinuedTools || !input.trim()}><Send size={14} /></button>
        )}
      </div>
    </div>
  );
}
