import { useState } from "react";
import { FileText, HardDrive, Save } from "lucide-react";
import { ExportHistory } from "../../../wailsjs/go/main/App";
import { types } from "../../../wailsjs/go/models";
import { appThemes, terminalThemes } from "../../constants";
import { normalizeAppTheme } from "../../utils/format";
import { Label } from "../modals/ModalShell";

export function SettingsPanel({ settings, onSave, onOpenData, dataDir }: { settings: types.AppSettings; onSave: (settings: types.AppSettings) => void; onOpenData: () => void; dataDir: string }) {
  const [draft, setDraft] = useState(new types.AppSettings(settings));
  const update = (patch: any) => setDraft(new types.AppSettings({ ...draft, ...patch }));
  const updateTerm = (patch: any) => setDraft(new types.AppSettings({ ...draft, terminal: { ...draft.terminal, ...patch } }));
  const setAppTheme = (theme: string) => {
    const termTheme = draft.terminal.themeName;
    update({ themeName: theme });
    if (termTheme === draft.themeName || termTheme === "gx Dark" || termTheme === "Light" || termTheme === "Deep Blue") {
      updateTerm({ themeName: theme });
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="panel dense space-y-1.5">
        <Label text="Lang"><select className="input compact-input" value={draft.language || "en"} onChange={(e) => update({ language: e.target.value })}><option value="en">English</option><option value="zh-CN">简体中文</option></select></Label>
        <Label text="Theme"><select className="input compact-input" value={normalizeAppTheme(draft.themeName)} onChange={(e) => setAppTheme(e.target.value)}>{appThemes.map((theme) => <option key={theme}>{theme}</option>)}</select></Label>
        <Label text="Term theme"><select className="input compact-input" value={draft.terminal.themeName} onChange={(e) => updateTerm({ themeName: e.target.value })}>{Object.keys(terminalThemes).map((theme) => <option key={theme}>{theme}</option>)}</select></Label>
        <Label text="Font"><input className="input compact-input" value={draft.terminal.fontFamily} onChange={(e) => updateTerm({ fontFamily: e.target.value })} /></Label>
        <div className="grid grid-cols-3 gap-1.5">
          <Label text="Size"><input className="input compact-input" type="number" value={draft.terminal.fontSize} onChange={(e) => updateTerm({ fontSize: Number(e.target.value) })} /></Label>
          <Label text="Monitor"><input className="input compact-input" type="number" value={draft.monitorIntervalSec} onChange={(e) => update({ monitorIntervalSec: Number(e.target.value) })} /></Label>
          <Label text="Timeout"><input className="input compact-input" type="number" value={draft.connectionTimeout} onChange={(e) => update({ connectionTimeout: Number(e.target.value) })} /></Label>
        </div>
        <label className="check"><input type="checkbox" checked={draft.monitorEnabled} onChange={(e) => update({ monitorEnabled: e.target.checked })} /> Enable monitor</label>
        <Label text="Highlighting"><select className="input compact-input" value={draft.highlightLevel || "off"} onChange={(e) => update({ highlightLevel: e.target.value })}><option value="off">Off</option><option value="basic">Basic (errors, warnings)</option><option value="full">Full (IP, paths, services)</option></select></Label>
        <label className="check"><input type="checkbox" checked={draft.smartHighlight} onChange={(e) => update({ smartHighlight: e.target.checked })} /> Highlight command output</label>
        <label className="check"><input type="checkbox" checked={draft.confirmOnDisconnect || false} onChange={(e) => update({ confirmOnDisconnect: e.target.checked })} /> Confirm before close</label>
      </div>
      <button className="btn-primary w-full text-[11px]" onClick={() => onSave(draft)}><Save size={13} /> Save</button>
      <button className="btn-secondary w-full text-[11px]" onClick={onOpenData}><HardDrive size={13} /> Open data</button>
      <button className="btn-secondary w-full text-[11px]" onClick={() => ExportHistory().catch(() => {})}><FileText size={13} /> Export history</button>
      <div className="truncate text-[10px] text-muted">{dataDir}</div>
    </div>
  );
}
