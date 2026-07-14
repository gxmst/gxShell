import { useMemo, useState } from "react";
import { Command, Edit3, Play, Plus, Search, Trash2, Zap } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import type { Tab } from "../../types";
import { t } from "../../i18n";

type CommandPanelProps = {
  commands: types.CommandTemplate[];
  tabs: Tab[];
  active?: Tab;
  locale: string;
  onRun: (cmd: types.CommandTemplate) => void;
  onRunInSession: (cmd: types.CommandTemplate, sessionId: string) => void;
  onRunAll: (cmd: types.CommandTemplate) => void;
  onEdit: (cmd: types.CommandTemplate) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
};

export function CommandPanel(props: CommandPanelProps) {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("active");
  const connectedTabs = useMemo(
    () => props.tabs.filter((tab) => tab.type !== "markdown" && tab.state === "connected"),
    [props.tabs],
  );
  const broadcastTabs = useMemo(() => connectedTabs.filter((tab) => !tab.local), [connectedTabs]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return props.commands;
    return props.commands.filter((cmd) => [cmd.name, cmd.command, cmd.category, cmd.description, ...(cmd.tags || [])]
      .some((value) => String(value || "").toLowerCase().includes(needle)));
  }, [props.commands, query]);

  const run = (cmd: types.CommandTemplate) => {
    if (target === "all") props.onRunAll(cmd);
    else if (target === "active") props.onRun(cmd);
    else props.onRunInSession(cmd, target);
  };
  const canRun = target === "all" ? broadcastTabs.length > 0 : target === "active" ? !!props.active && props.active.state === "connected" && props.active.type !== "markdown" : connectedTabs.some((tab) => tab.id === target);

  return (
    <div className="panel-page command-panel">
      <div className="panel-page-header">
        <div className="panel-page-heading">
          <span className="panel-page-icon"><Command size={14} /></span>
          <span><strong>{t(props.locale, "cmd")}</strong><small>{props.locale === "zh-CN" ? `${filtered.length}/${props.commands.length} 个命令模板` : `${filtered.length}/${props.commands.length} command templates`}</small></span>
        </div>
        <button className="panel-page-primary" onClick={props.onNew}><Plus size={12} /> {t(props.locale, "newCommand")}</button>
      </div>
      <div className="flex gap-2 px-3 pb-2">
        <label className="relative flex-1 min-w-0">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <input className="input compact-input w-full pl-7" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t(props.locale, "search")} />
        </label>
        <select className="input compact-input min-w-0 max-w-[45%]" value={target} onChange={(event) => setTarget(event.target.value)} title={props.locale === "zh-CN" ? "执行目标" : "Run target"}>
          <option value="active">{props.locale === "zh-CN" ? "当前会话" : "Active session"}</option>
          <option value="all">{props.locale === "zh-CN" ? `全部 SSH (${broadcastTabs.length})` : `All SSH (${broadcastTabs.length})`}</option>
          {connectedTabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title}</option>)}
        </select>
      </div>
      <div className="panel-list">
        {filtered.map((cmd) => (
          <div key={cmd.id} className="command-row panel-item">
            <span className="panel-item-icon"><Command size={12} /></span>
            <div className="panel-item-copy">
              <div className="panel-item-title">{cmd.name}</div>
              <div className="panel-item-meta">{cmd.command}</div>
            </div>
            <div className="panel-item-actions">
              <button className="mini-btn" disabled={!canRun} onClick={(event) => { event.stopPropagation(); run(cmd); }} title={target === "all" ? t(props.locale, "runAll") : t(props.locale, "run")}>
                {target === "all" ? <Zap size={10} /> : <Play size={10} />}
              </button>
              <button className="mini-btn" onClick={(event) => { event.stopPropagation(); props.onEdit(new types.CommandTemplate(cmd)); }}><Edit3 size={10} /></button>
              <button className="mini-btn danger" onClick={(event) => { event.stopPropagation(); props.onDelete(cmd.id); }}><Trash2 size={10} /></button>
            </div>
          </div>
        ))}
        {!filtered.length && <div className="panel-empty"><Command size={20} /><span>{query ? (props.locale === "zh-CN" ? "没有匹配的命令" : "No matching commands") : (props.locale === "zh-CN" ? "还没有命令模板" : "No command templates yet")}</span></div>}
      </div>
    </div>
  );
}
