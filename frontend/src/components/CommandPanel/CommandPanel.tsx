import { Command, Edit3, Play, Plus, Trash2, Zap } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import type { Tab } from "../../types";
import { t } from "../../i18n";

export function CommandPanel(props: { commands: types.CommandTemplate[]; active?: Tab; locale: string; onRun: (cmd: types.CommandTemplate) => void; onRunAll: (cmd: types.CommandTemplate) => void; onEdit: (cmd: types.CommandTemplate) => void; onDelete: (id: string) => void; onNew: () => void }) {
  return (
    <div className="panel-page command-panel">
      <div className="panel-page-header">
        <div className="panel-page-heading">
          <span className="panel-page-icon"><Command size={14} /></span>
          <span><strong>{t(props.locale, "cmd")}</strong><small>{props.locale === "zh-CN" ? `${props.commands.length} 个命令模板` : `${props.commands.length} command templates`}</small></span>
        </div>
        <button className="panel-page-primary" onClick={props.onNew}><Plus size={12} /> {t(props.locale, "newCommand")}</button>
      </div>
      <div className="panel-list">
      {props.commands.map((cmd) => (
        <div key={cmd.id} className="command-row panel-item">
          <span className="panel-item-icon"><Command size={12} /></span>
          <div className="panel-item-copy">
            <div className="panel-item-title">{cmd.name}</div>
            <div className="panel-item-meta">{cmd.command}</div>
          </div>
          <div className="panel-item-actions">
            <button className="mini-btn" disabled={!props.active} onClick={(e) => { e.stopPropagation(); props.onRun(cmd); }} title={t(props.locale, "run")}><Play size={10} /></button>
            <button className="mini-btn" onClick={(e) => { e.stopPropagation(); props.onRunAll(cmd); }} title={t(props.locale, "runAll")}><Zap size={10} /></button>
            <button className="mini-btn" onClick={(e) => { e.stopPropagation(); props.onEdit(new types.CommandTemplate(cmd)); }}><Edit3 size={10} /></button>
            <button className="mini-btn danger" onClick={(e) => { e.stopPropagation(); props.onDelete(cmd.id); }}><Trash2 size={10} /></button>
          </div>
        </div>
      ))}
      {!props.commands.length && <div className="panel-empty"><Command size={20} /><span>{props.locale === "zh-CN" ? "还没有命令模板" : "No command templates yet"}</span></div>}
      </div>
    </div>
  );
}
