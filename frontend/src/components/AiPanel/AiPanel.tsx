import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Check, MessageSquarePlus, Play, RefreshCw, Send, Settings2, Stethoscope, X } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { types } from "../../../wailsjs/go/models";
import { AiChat, AiContinueChat, AiExecuteTool, GetAiConfig, GetAiUsage, ListAiModels, ResetAiUsage, SaveAiConfig } from "../../../wailsjs/go/main/App";
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
};

let sessionCounter = 0;

marked.setOptions({ breaks: true, gfm: true });

function MarkdownContent({ content }: { content: string }) {
  const rawHtml = marked.parse(content) as string;
  const html = DOMPurify.sanitize(rawHtml);
  return <div className="ai-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function ToolCallBlock({ tc, result, onApprove, sessionId }: { tc: ToolCallData; result?: ToolResultData; onApprove: () => void; sessionId: string }) {
  let args: any = {};
  try { args = JSON.parse(tc.function.arguments); } catch {}

  const isCommand = tc.function.name === "execute_command";
  const isReadFile = tc.function.name === "read_file";
  const cmdText = isCommand ? args.command : isReadFile ? `cat ${args.path}` : tc.function.arguments;

  return (
    <div className="ai-tool-call">
      <div className="ai-tool-call-header">
        <Play size={10} className="text-accent" />
        <span className="text-[10px] font-semibold">{isCommand ? "🔧 Execute" : isReadFile ? "📄 Read File" : tc.function.name}</span>
      </div>
      <code className="ai-tool-call-cmd">{cmdText}</code>
      {result?.executed && (
        <pre className="ai-tool-call-result">{result.content.length > 2000 ? result.content.slice(0, 2000) + "\n... (truncated)" : result.content}</pre>
      )}
      {result?.executing && <div className="ai-tool-call-status">⏳ Executing...</div>}
      {!result?.executed && !result?.executing && (
        <div className="ai-tool-call-actions">
          <button className="ai-tool-approve-btn" onClick={onApprove}><Check size={10} /> Run</button>
        </div>
      )}
    </div>
  );
}

export function AiPanel(props: { active?: Tab; locale: string; onNotify: (text: string, tone?: Toast["tone"]) => void; getTerminalLines: (id: string, lineCount: number) => string; activeTabId: string }) {
  const lang = props.locale;
  const [sessions, setSessions] = useState<ChatSession[]>(() => {
    try {
      const stored = localStorage.getItem("gx:ai-sessions");
      if (stored) return JSON.parse(stored);
    } catch {}
    return [];
  });
  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    try { return localStorage.getItem("gx:ai-active-session") || ""; } catch { return ""; }
  });
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
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
  const activeSessionIdRef = useRef(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const pendingToolCallsRef = useRef<ToolCallData[]>([]);
  const pendingAssistantMsgRef = useRef<ChatMsg | null>(null);

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const messages = activeSession?.messages || [];

  const MAX_STORED_SESSIONS = 20;
  const MAX_MSG_LENGTH = 8000;

  useEffect(() => {
    try {
      const trimmed = sessions.slice(0, MAX_STORED_SESSIONS).map(s => ({
        ...s,
        messages: s.messages.map(m => ({
          ...m,
          content: m.content.length > MAX_MSG_LENGTH ? m.content.slice(0, MAX_MSG_LENGTH) + "..." : m.content,
          reasoningContent: m.reasoningContent && m.reasoningContent.length > MAX_MSG_LENGTH ? m.reasoningContent.slice(0, MAX_MSG_LENGTH) + "..." : m.reasoningContent,
          toolResults: m.toolResults?.map(tr => ({
            ...tr,
            content: tr.content.length > MAX_MSG_LENGTH ? tr.content.slice(0, MAX_MSG_LENGTH) + "..." : tr.content,
          })),
        })),
      }));
      localStorage.setItem("gx:ai-sessions", JSON.stringify(trimmed));
    } catch {}
  }, [sessions]);
  useEffect(() => { try { localStorage.setItem("gx:ai-active-session", activeSessionId); } catch {} }, [activeSessionId]);
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

  const executeToolAndContinue = useCallback(async (sessionId: string, tc: ToolCallData) => {
    const sid = activeSessionIdRef.current;
    setSessions((prev) => prev.map((s) => {
      if (s.id !== sid) return s;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last.role === "assistant" && last.toolResults) {
        const newResults = last.toolResults.map((tr) =>
          tr.toolCallId === tc.id ? { ...tr, executing: true } : tr
        );
        msgs[msgs.length - 1] = { ...last, toolResults: newResults };
      }
      return { ...s, messages: msgs };
    }));

    try {
      const output = await AiExecuteTool(sessionId, tc.id, tc.function.name, tc.function.arguments);
      setSessions((prev) => prev.map((s) => {
        if (s.id !== sid) return s;
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last.role === "assistant" && last.toolResults) {
          const newResults = last.toolResults.map((tr) =>
            tr.toolCallId === tc.id ? { ...tr, content: output, executing: false, executed: true } : tr
          );
          msgs[msgs.length - 1] = { ...last, toolResults: newResults };
        }
        return { ...s, messages: msgs };
      }));
    } catch (err) {
      onNotifyRef.current("Tool execution failed: " + String(err), "error");
      setSessions((prev) => prev.map((s) => {
        if (s.id !== sid) return s;
        const msgs = [...s.messages];
        const last = msgs[msgs.length - 1];
        if (last.role === "assistant" && last.toolResults) {
          const newResults = last.toolResults.map((tr) =>
            tr.toolCallId === tc.id ? { ...tr, content: "Error: " + String(err), executing: false, executed: true } : tr
          );
          msgs[msgs.length - 1] = { ...last, toolResults: newResults };
        }
        return { ...s, messages: msgs };
      }));
    }
  }, []);

  useEffect(() => {
    if (streaming) return;
    const session = sessions.find((s) => s.id === activeSessionId);
    if (!session) return;
    const lastMsg = session.messages[session.messages.length - 1];
    if (!lastMsg || lastMsg.role !== "assistant") return;
    if (!lastMsg.toolCalls || !lastMsg.toolResults) return;
    if (lastMsg.toolContinued) return;
    if (!lastMsg.toolResults.every((tr) => tr.executed)) return;
    if (lastMsg.toolResults.some((tr) => tr.executing)) return;

    const sid = activeSessionId;
    setSessions((prev) => prev.map((s) => {
      if (s.id !== sid) return s;
      const msgs = [...s.messages];
      const last = msgs[msgs.length - 1];
      if (last.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, toolContinued: true };
      }
      return { ...s, messages: [...msgs, { role: "assistant", content: "" }] };
    }));

    const apiMessages: types.AiMessage[] = [];
    for (const m of session.messages) {
      if (m.role === "tool") continue;
      const msgObj = new types.AiMessage({ role: m.role, content: m.content, toolCallId: m.toolCallId || "" });
      if (m.reasoningContent) {
        msgObj.reasoningContent = m.reasoningContent;
      }
      if (m.toolCalls) {
        msgObj.toolCalls = m.toolCalls.map((tc2) => new types.AiToolCall({
          id: tc2.id, type: tc2.type,
          function: new types.AiFunctionCall({ name: tc2.function.name, arguments: tc2.function.arguments }),
        }));
      }
      apiMessages.push(msgObj);

      if (m.role === "assistant" && m.toolResults && m.toolResults.every((tr) => tr.executed) && !m.toolResults.some((tr) => tr.executing)) {
        for (const tr of m.toolResults) {
          apiMessages.push(new types.AiMessage({ role: "tool", content: tr.content, toolCallId: tr.toolCallId }));
        }
      }
    }

    setStreaming(true);
    const terminalCtx = props.getTerminalLines(props.activeTabId, 10);
    const req = new types.AiChatRequest({
      messages: apiMessages,
      context: terminalCtx,
    });
    AiContinueChat(req).catch((err) => {
      setStreaming(false);
      onNotifyRef.current("Continue chat failed: " + String(err), "error");
    });
  }, [sessions, streaming, activeSessionId, props.getTerminalLines, props.activeTabId]);

  useEffect(() => {
    const off = EventsOn("ai:chunk", (data: any) => {
      if (data.toolCalls && data.toolCalls.length > 0 && data.finish) {
        const toolCalls: ToolCallData[] = data.toolCalls;
        const sid = activeSessionIdRef.current;

        const toolResults: ToolResultData[] = toolCalls.map((tc: ToolCallData) => ({
          toolCallId: tc.id,
          content: "",
          executing: false,
          executed: false,
        }));

        setSessions((prev) => prev.map((s) => {
          if (s.id !== sid) return s;
          const msgs = [...s.messages];
          if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
            msgs[msgs.length - 1] = {
              ...msgs[msgs.length - 1],
              toolCalls,
              toolResults,
            };
          }
          return { ...s, messages: msgs };
        }));

        setStreaming(false);
        GetAiUsage().then(setUsage).catch(() => {});
        return;
      }

      if (data.finish) {
        setStreaming(false);
        GetAiUsage().then(setUsage).catch(() => {});
      } else if (data.content) {
        const sid = activeSessionIdRef.current;
        setSessions((prev) => {
          const next = prev.map((s) => {
            if (s.id !== sid) return s;
            const msgs = [...s.messages];
            if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], content: msgs[msgs.length - 1].content + data.content };
            }
            return { ...s, messages: msgs };
          });
          return next;
        });
      } else if (data.reasoningContent) {
        const sid = activeSessionIdRef.current;
        setSessions((prev) => {
          const next = prev.map((s) => {
            if (s.id !== sid) return s;
            const msgs = [...s.messages];
            if (msgs.length > 0 && msgs[msgs.length - 1].role === "assistant") {
              const prev2 = msgs[msgs.length - 1].reasoningContent || "";
              msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], reasoningContent: prev2 + data.reasoningContent };
            }
            return { ...s, messages: msgs };
          });
          return next;
        });
      }
    });
    const offErr = EventsOn("ai:error", (data: any) => {
      setStreaming(false);
      onNotifyRef.current(data.error || "AI error", "error");
    });
    return () => { off(); offErr(); };
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const newSession = useCallback(() => {
    const id = "ai-sess-" + Date.now() + "-" + (++sessionCounter);
    const title = t(lang, "aiNewChat") + " " + (sessions.length + 1);
    const sess: ChatSession = { id, title, messages: [], createdAt: Date.now() };
    setSessions((prev) => [sess, ...prev]);
    setActiveSessionId(id);
    setInput("");
    setStreaming(false);
  }, [lang, sessions.length]);

  useEffect(() => { if (sessions.length === 0 && !activeSessionId) newSession(); }, []);

  const switchSession = useCallback((id: string) => { setActiveSessionId(id); setShowSessionList(false); }, []);
  const deleteSession = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSessionId === id) {
      setActiveSessionId(() => {
        const remaining = sessions.filter((s) => s.id !== id);
        return remaining.length > 0 ? remaining[0].id : "";
      });
    }
  }, [activeSessionId, sessions]);

  const saveSettings = useCallback(async () => {
    try {
      await SaveAiConfig("openai", apiKey, endpoint, model);
      setShowSettings(false);
      onNotifyRef.current("AI settings saved", "success");
    } catch (err) {
      onNotifyRef.current("Save failed: " + String(err), "error");
    }
  }, [apiKey, endpoint, model]);

  const fetchModels = useCallback(async () => {
    setFetchingModels(true);
    try {
      const models = await ListAiModels("openai", apiKey, endpoint);
      setModelList(models || []);
      if (!models || models.length === 0) onNotifyRef.current("No models found", "info");
    } catch (err) { onNotifyRef.current(String(err), "error"); }
    finally { setFetchingModels(false); }
  }, [apiKey, endpoint]);

  const sendChat = useCallback((userText: string, extraContext?: string) => {
    if (!userText.trim() || streaming) return;
    if (!model) { onNotifyRef.current("AI model not configured — click ⚙ to set up", "error"); return; }

    const terminalCtx = extraContext || props.getTerminalLines(props.activeTabId, 10);
    let displayContent = userText.trim();
    let apiContent = userText.trim();
    if (terminalCtx) apiContent += "\n\n[Terminal Output]\n```\n" + terminalCtx + "\n```";

    const userMsg: ChatMsg = { role: "user", content: displayContent };
    const assistantMsg: ChatMsg = { role: "assistant", content: "" };

    setSessions((prev) => prev.map((s) => {
      if (s.id !== activeSessionId) return s;
      const newMsgs = [...s.messages, userMsg, assistantMsg];
      const title = s.messages.length === 0 ? displayContent.slice(0, 30) + (displayContent.length > 30 ? "..." : "") : s.title;
      return { ...s, messages: newMsgs, title };
    }));

    setInput("");
    setStreaming(true);

    const apiUserMsg: ChatMsg = { role: "user", content: apiContent };
    const currentMsgs = [...messages, apiUserMsg];
    const req = new types.AiChatRequest({
      messages: currentMsgs.filter((m) => m.content).map((m) => new types.AiMessage({ role: m.role, content: m.content })),
      context: terminalCtx,
    });
    AiChat(req).catch((err) => { setStreaming(false); onNotifyRef.current("Chat failed: " + String(err), "error"); });
  }, [messages, streaming, activeSessionId, model, props.getTerminalLines, props.activeTabId]);

  const send = useCallback(() => { sendChat(input); }, [input, sendChat]);

  const diagnose = useCallback(() => {
    if (streaming) return;
    const ctx = props.getTerminalLines(props.activeTabId, 30);
    const prompt = ctx ? t(lang, "aiDiagnose") + "\n\n--- Terminal Output ---\n" + ctx : t(lang, "aiDiagnose") + " (no terminal output available)";
    sendChat(prompt, ctx);
  }, [streaming, lang, sendChat, props.getTerminalLines, props.activeTabId]);

  const onKeyDown = (e: React.KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } };

  return (
    <div className="ai-panel" style={{ position: "relative" }}>
      <div className="ai-header">
        <div className="flex items-center gap-1.5">
          <Bot size={14} className="text-accent" />
          <span className="text-[11px] font-semibold">{activeSession?.title || t(lang, "aiAssistant")}</span>
        </div>
        <div className="flex items-center gap-1">
          <button className="mini-btn" onClick={newSession} title={t(lang, "aiNewChat")}><MessageSquarePlus size={11} /></button>
          <button className={`mini-btn ${showSessionList ? "text-accent" : ""}`} onClick={() => setShowSessionList((v) => !v)} title={t(lang, "aiChatHistory")}><Bot size={11} /></button>
          <button className={`mini-btn ${showSettings ? "text-accent" : ""}`} onClick={() => { setShowSettings((v) => !v); if (!showSettings) loadSettings(); }} title={t(lang, "aiSettings")}><Settings2 size={11} /></button>
          <button className="mini-btn" onClick={diagnose} title={t(lang, "aiDiagnose")}><Stethoscope size={11} /></button>
        </div>
      </div>

      {showSessionList && (
        <div className="ai-settings-popup">
          <div className="ai-settings-popup-header">
            <span className="text-[11px] font-semibold text-accent">{t(lang, "aiChatHistory")}</span>
            <button className="mini-btn" onClick={() => setShowSessionList(false)}><X size={10} /></button>
          </div>
          <div className="ai-session-list">
            {sessions.length === 0 && <div className="text-[10px] text-muted p-2">{t(lang, "aiNoChats")}</div>}
            {sessions.map((s) => (
              <div key={s.id} className={`ai-session-item ${s.id === activeSessionId ? "active" : ""}`} onClick={() => switchSession(s.id)}>
                <span className="ai-session-title truncate">{s.title}</span>
                <button className="mini-btn text-[9px] opacity-40 hover:opacity-100" onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }}><X size={8} /></button>
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
            <Label text="Preset">
              <select className="input compact-input" value={endpoint === "https://api.deepseek.com/v1" ? "deepseek" : "custom"} onChange={(e) => {
                if (e.target.value === "deepseek") { setEndpoint("https://api.deepseek.com/v1"); setModel("deepseek-chat"); }
                else { setEndpoint(""); setModel(""); }
                setModelList([]);
              }}>
                <option value="custom">OpenAI Compatible</option>
                <option value="deepseek">DeepSeek</option>
              </select>
            </Label>
            <Label text={t(lang, "aiApiKey")}><input className="input compact-input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." /></Label>
            <Label text={t(lang, "aiEndpoint")}><input className="input compact-input" value={endpoint} onChange={(e) => { setEndpoint(e.target.value); setModelList([]); }} placeholder="https://api.openai.com/v1" /></Label>
            <Label text={t(lang, "aiModel")}>
              <div className="flex gap-1 items-center">
                {modelList.length > 0 ? (
                  <select className="input compact-input flex-1" value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="">{t(lang, "aiSelectModel")}</option>
                    {modelList.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                ) : (
                  <input className="input compact-input flex-1" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o / deepseek-chat" />
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
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === "user" ? "ai-msg-user" : msg.role === "tool" ? "ai-msg-tool" : "ai-msg-assistant"}>
            {msg.role === "assistant" && <Bot size={12} className="ai-msg-icon" />}
            <div className="ai-msg-content">
              {msg.role === "assistant" && msg.content ? (
                <MarkdownContent content={msg.content} />
              ) : msg.role === "assistant" && streaming && i === messages.length - 1 && !msg.content ? (
                <span className="ai-typing-indicator"><span /><span /><span /></span>
              ) : msg.role === "assistant" && !msg.content && !msg.toolCalls ? null : msg.role === "user" ? msg.content : ""}

              {msg.toolCalls && msg.toolCalls.map((tc, j) => (
                <ToolCallBlock
                  key={tc.id || j}
                  tc={tc}
                  result={msg.toolResults?.find((tr) => tr.toolCallId === tc.id)}
                  onApprove={() => executeToolAndContinue(props.activeTabId, tc)}
                  sessionId={props.activeTabId}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {usage && usage.totalTokens > 0 && (
        <div className="ai-usage">
          <span>{t(lang, "aiTokenUsage")}: {usage.totalTokens.toLocaleString()}</span>
          <button className="text-[9px] opacity-60 hover:opacity-100" onClick={() => { ResetAiUsage(); setUsage(new types.AiTokenUsage()); }}>Reset</button>
        </div>
      )}

      <div className="ai-config-hint">
        {model ? (
          <span className="text-[9px] text-muted truncate">
            {model} {endpoint ? `@ ${endpoint.replace(/^https?:\/\//, "").split("/")[0]}` : ""}
            {apiKey ? " 🔑" : " ⚠️ No API Key"}
            {(() => { const tc = props.getTerminalLines(props.activeTabId, 1); return tc ? " 📺" : " 📺✗"; })()}
          </span>
        ) : (
          <span className="text-[9px] text-muted">⚠️ Not configured — click ⚙ to set up</span>
        )}
      </div>

      <div className="ai-input-row">
        <textarea
          ref={inputRef}
          className="ai-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t(lang, "aiInputPlaceholder")}
          rows={2}
          disabled={streaming}
        />
        <button className="ai-send-btn" onClick={send} disabled={streaming || !input.trim()}>
          <Send size={14} />
        </button>
      </div>
    </div>
  );
}
