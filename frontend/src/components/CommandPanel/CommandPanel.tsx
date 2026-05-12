import { Command, Edit3, Play, Plus, Trash2 } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import type { Tab } from "../../types";

export function CommandPanel(props: { commands: types.CommandTemplate[]; active?: Tab; onRun: (cmd: types.CommandTemplate) => void; onEdit: (cmd: types.CommandTemplate) => void; onDelete: (id: string) => void; onNew: () => void }) {
  return (
    <div className="space-y-1">
      <button className="btn-secondary w-full text-[11px]" onClick={props.onNew}><Plus size={13} /> New command</button>
      {props.commands.map((cmd) => (
        <div key={cmd.id} className="command-row">
          <Command size={12} className="text-accent shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium">{cmd.name}</div>
            <div className="truncate font-mono text-[10px] text-muted">{cmd.command}</div>
          </div>
          <button className="mini-btn" disabled={!props.active} onClick={(e) => { e.stopPropagation(); props.onRun(cmd); }}><Play size={10} /></button>
          <button className="mini-btn" onClick={(e) => { e.stopPropagation(); props.onEdit(new types.CommandTemplate(cmd)); }}><Edit3 size={10} /></button>
          <button className="mini-btn danger" onClick={(e) => { e.stopPropagation(); props.onDelete(cmd.id); }}><Trash2 size={10} /></button>
        </div>
      ))}
    </div>
  );
}
