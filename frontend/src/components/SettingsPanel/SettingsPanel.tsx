import { useState } from "react";
import { HardDrive, Save } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { appThemes, terminalThemes } from "../../constants";
import { normalizeAppTheme } from "../../utils/format";
import { Label } from "../modals/ModalShell";

export function SettingsPanel({ settings, onSave, onOpenData, dataDir }: { settings: types.AppSettings; onSave: (settings: types.AppSettings) => void; onOpenData: () => void; dataDir: string }) {
  const [draft, setDraft] = useState(new types.AppSettings(settings));
  const update = (patch: any) => setDraft(new types.AppSettings({ ...draft, ...patch }));
  const updateTerm = (patch: any) => setDraft(new types.AppSettings({ ...draft, terminal: { ...draft.terminal, ...patch } }));
  const setAppTheme = (theme: string) => update({ themeName: theme, terminal: { ...draft.terminal, themeName: theme } });
  return (
    <div className="space-y-2">
      <div className="panel dense space-y-2">
        <Label text="App theme"><select className="input compact-input" value={normalizeAppTheme(draft.themeName)} onChange={(e) => setAppTheme(e.target.value)}>{appThemes.map((theme) => <option key={theme}>{theme}</option>)}</select></Label>
        <Label text="Terminal theme"><select className="input compact-input" value={draft.terminal.themeName} onChange={(e) => updateTerm({ themeName: e.target.value })}>{Object.keys(terminalThemes).map((theme) => <option key={theme}>{theme}</option>)}</select></Label>
        <Label text="Font"><input className="input compact-input" value={draft.terminal.fontFamily} onChange={(e) => updateTerm({ fontFamily: e.target.value })} /></Label>
        <div className="grid grid-cols-2 gap-2">
          <Label text="Size"><input className="input compact-input" type="number" value={draft.terminal.fontSize} onChange={(e) => updateTerm({ fontSize: Number(e.target.value) })} /></Label>
          <Label text="Monitor"><input className="input compact-input" type="number" value={draft.monitorIntervalSec} onChange={(e) => update({ monitorIntervalSec: Number(e.target.value) })} /></Label>
        </div>
        <label className="check"><input type="checkbox" checked={draft.monitorEnabled} onChange={(e) => update({ monitorEnabled: e.target.checked })} /> Enable monitor</label>
        <label className="check"><input type="checkbox" checked={draft.smartHighlight} onChange={(e) => update({ smartHighlight: e.target.checked })} /> Smart Highlight placeholder</label>
      </div>
      <button className="btn-primary w-full" onClick={() => onSave(draft)}><Save size={15} /> Save settings</button>
      <button className="btn-secondary w-full" onClick={onOpenData}><HardDrive size={15} /> Open data</button>
      <div className="truncate text-[11px] text-muted">{dataDir}</div>
    </div>
  );
}

