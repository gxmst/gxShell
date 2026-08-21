import { AlertTriangle, Keyboard } from "lucide-react";
import { useMemo } from "react";
import type { ActionContext, ActionDefinition } from "../../actions/actionRegistry";
import { DialogHeader, ModalShell } from "./ModalShell";

export function ShortcutHelpDialog(props: {
  actions: ActionDefinition<ActionContext>[];
  conflicts: Map<string, ActionDefinition<ActionContext>[]>;
  language: string;
  onClose: () => void;
}) {
  const zh = props.language === "zh-CN";
  const groups = useMemo(() => {
    const grouped = new Map<string, ActionDefinition<ActionContext>[]>();
    for (const action of props.actions) {
      const list = grouped.get(action.category) || [];
      list.push(action);
      grouped.set(action.category, list);
    }
    return [...grouped.entries()];
  }, [props.actions]);

  return (
    <ModalShell onClose={props.onClose} ariaLabel={zh ? "快捷键" : "Keyboard shortcuts"}>
      <div className="shortcut-help-dialog">
        <DialogHeader icon={<Keyboard size={15} />} title={zh ? "快捷键" : "Keyboard shortcuts"} />
        {props.conflicts.size > 0 && (
          <div className="shortcut-conflict" role="alert"><AlertTriangle size={13} /> {zh ? `${props.conflicts.size} 组快捷键存在冲突` : `${props.conflicts.size} shortcut conflicts`}</div>
        )}
        <div className="shortcut-help-list">
          {groups.map(([category, actions]) => (
            <section key={category}>
              <h3>{category}</h3>
              {actions.map((action) => (
                <div className="shortcut-help-row" key={action.id}>
                  <span>{action.label}</span>
                  <span className="shortcut-help-keys">
                    {action.defaultShortcuts.length > 0
                      ? action.defaultShortcuts.map((shortcut) => <kbd key={shortcut}>{shortcut}</kbd>)
                      : <small>{zh ? "命令面板" : "Command palette"}</small>}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
        <div className="dialog-actions"><button className="btn-primary" onClick={props.onClose}>{zh ? "完成" : "Done"}</button></div>
      </div>
    </ModalShell>
  );
}
