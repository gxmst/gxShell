import { useState, useEffect } from "react";
import { FileText, HardDrive, Save } from "lucide-react";
import { ExportHistory, IsTextContextMenuRegistered, RegisterTextContextMenu, UnregisterTextContextMenu } from "../../../wailsjs/go/main/App";
import { types } from "../../../wailsjs/go/models";
import { appThemes, fontPresets, terminalThemes } from "../../constants";
import { normalizeAppTheme } from "../../utils/format";
import { t } from "../../i18n";
import { Label } from "../modals/ModalShell";

export function SettingsPanel({ settings, language, onSave, onOpenData, dataDir, onNotify }: { settings: types.AppSettings; language: string; onSave: (settings: types.AppSettings) => void; onOpenData: () => void; dataDir: string; onNotify?: (text: string, tone?: 'info' | 'error' | 'success') => void }) {
  const lang = language;
  const [draft, setDraft] = useState(new types.AppSettings(settings));
  const [mdMenu, setMdMenu] = useState(false);
  const update = (patch: any) => setDraft(prev => new types.AppSettings({ ...prev, ...patch }));
  const updateTerm = (patch: any) => setDraft(prev => new types.AppSettings({ ...prev, terminal: { ...prev.terminal, ...patch } }));

  // The right-click registration reflects live registry state, not settings.json,
  // so it is read on mount and toggled immediately rather than saved with the form.
  useEffect(() => {
    IsTextContextMenuRegistered().then(setMdMenu).catch(() => setMdMenu(false));
  }, []);

  const toggleMdMenu = async (checked: boolean) => {
    try {
      if (checked) await RegisterTextContextMenu();
      else await UnregisterTextContextMenu();
      setMdMenu(checked);
    } catch (err) {
      onNotify?.(`${t(lang, "mdContextMenuFailed")}: ${String(err)}`, "error");
      // Re-read so the checkbox reflects the real state after a failure.
      IsTextContextMenuRegistered().then(setMdMenu).catch(() => {});
    }
  };
  const setAppTheme = (theme: string) => {
    const termTheme = draft.terminal.themeName;
    const syncedThemes = [draft.themeName, "gx Dark", ...appThemes];
    if (syncedThemes.includes(termTheme)) {
      setDraft(prev => new types.AppSettings({ ...prev, themeName: theme, terminal: { ...prev.terminal, themeName: theme } }));
    } else {
      update({ themeName: theme });
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="panel dense space-y-1.5">
        <Label text={t(lang, "lang")}><select className="input compact-input" value={draft.language || "en"} onChange={(e) => update({ language: e.target.value })}><option value="en">English</option><option value="zh-CN">简体中文</option></select></Label>
        <Label text={t(lang, "theme")}><select className="input compact-input" value={normalizeAppTheme(draft.themeName)} onChange={(e) => setAppTheme(e.target.value)}>{appThemes.map((theme) => <option key={theme}>{theme}</option>)}</select></Label>
        <Label text={t(lang, "termTheme")}><select className="input compact-input" value={draft.terminal.themeName} onChange={(e) => updateTerm({ themeName: e.target.value })}>{Object.keys(terminalThemes).map((theme) => <option key={theme}>{theme}</option>)}</select></Label>
        <Label text={t(lang, "font")}><select className="input compact-input" value={draft.terminal.fontFamily} onChange={(e) => updateTerm({ fontFamily: e.target.value })}>{fontPresets.map((f) => <option key={f} value={f}>{f.split(",")[0].trim()}</option>)}</select></Label>
        <div className="grid grid-cols-3 gap-1.5">
          <Label text={t(lang, "size")}><input className="input compact-input" type="number" value={draft.terminal.fontSize} onChange={(e) => updateTerm({ fontSize: Number(e.target.value) })} /></Label>
          <Label text={t(lang, "monitorInterval")}><input className="input compact-input" type="number" value={draft.monitorIntervalSec} onChange={(e) => update({ monitorIntervalSec: Number(e.target.value) })} /></Label>
          <Label text={t(lang, "timeout")}><input className="input compact-input" type="number" value={draft.connectionTimeout} onChange={(e) => update({ connectionTimeout: Number(e.target.value) })} /></Label>
        </div>
        <label className="check"><input type="checkbox" checked={draft.monitorEnabled} onChange={(e) => update({ monitorEnabled: e.target.checked })} /> {t(lang, "enableMonitor")}</label>
        <Label text={t(lang, "highlighting")}><select className="input compact-input" value={draft.highlightLevel || "off"} onChange={(e) => update({ highlightLevel: e.target.value })}><option value="off">{t(lang, "highlightOff")}</option><option value="basic">{t(lang, "highlightBasic")}</option><option value="full">{t(lang, "highlightFull")}</option></select></Label>
        <label className="check"><input type="checkbox" checked={draft.confirmOnDisconnect || false} onChange={(e) => update({ confirmOnDisconnect: e.target.checked })} /> {t(lang, "confirmClose")}</label>
        <label className="check"><input type="checkbox" checked={draft.cliServerEnabled ?? true} onChange={(e) => update({ cliServerEnabled: e.target.checked })} /> {t(lang, "cliServerEnabled")}</label>
        <div className="text-[10px] text-muted leading-snug">{t(lang, "cliServerEnabledHint")}</div>
        <label className="check"><input type="checkbox" checked={mdMenu} onChange={(e) => toggleMdMenu(e.target.checked)} /> {t(lang, "mdContextMenu")}</label>
        <div className="text-[10px] text-muted leading-snug">{t(lang, "mdContextMenuHint")}</div>
      </div>
      <button className="btn-primary w-full text-[11px]" onClick={() => onSave(draft)}><Save size={13} /> {t(lang, "save")}</button>

      <button className="btn-secondary w-full text-[11px]" onClick={onOpenData}><HardDrive size={13} /> {t(lang, "openData")}</button>
      <button className="btn-secondary w-full text-[11px]" onClick={() => ExportHistory().catch(() => {})}><FileText size={13} /> {t(lang, "exportHistory")}</button>
      <div className="truncate text-[10px] text-muted">{dataDir}</div>
    </div>
  );
}
