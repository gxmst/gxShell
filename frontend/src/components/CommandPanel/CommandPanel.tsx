import { Command, Edit3, Play, Plus, Trash2 } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import type { Tab } from "../../types";

export function CommandPanel(props: { commands: types.CommandTemplate[]; active?: Tab; onRun: (cmd: types.CommandTemplate) => void; onEdit: (cmd: types.CommandTemplate) => void; onDelete: (id: string) => void; onNew: () => void }) {
  return (
    <div className="space-y-2">
      <button className="btn-secondary w-full" onClick={props.onNew}><Plus size={15} /> New command</button>
      {props.commands.map((cmd) => (
        <div key={cmd.id} className="command-row">
          <Command size={14} className="text-accent" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{cmd.name}</div>
            <div className="truncate font-mono text-[11px] text-muted">{cmd.command}</div>
          </div>
          <button className="mini-btn" disabled={!props.active} onClick={() => props.onRun(cmd)}><Play size={11} /></button>
          <button className="mini-btn" onClick={() => props.onEdit(new types.CommandTemplate(cmd))}><Edit3 size={11} /></button>
          <button className="mini-btn danger" onClick={() => props.onDelete(cmd.id)}><Trash2 size={11} /></button>
        </div>
      ))}
    </div>
  );
}

