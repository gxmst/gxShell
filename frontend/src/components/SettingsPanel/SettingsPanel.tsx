import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Activity, Database, FileText, HardDrive, Palette, Save, Settings2, ShieldCheck, TerminalSquare } from "lucide-react";
import { ExportHistory, IsTextContextMenuRegistered, RegisterTextContextMenu, UnregisterTextContextMenu } from "../../../wailsjs/go/main/App";
import { types } from "../../../wailsjs/go/models";
import { appThemes, fontPresets, terminalThemes } from "../../constants";
import { normalizeAppTheme } from "../../utils/format";
import { t } from "../../i18n";
import { KnownHostsManager } from "./KnownHostsManager";

const themePreview: Record<string, { bg: string; surface: string; accent: string }> = {
  Light: { bg: "#e8edf4", surface: "#f8fafd", accent: "#2563eb" },
  Dark: { bg: "#050b14", surface: "#16283d", accent: "#4ec4ff" },
  "Deep Blue": { bg: "#04101f", surface: "#123862", accent: "#5cbcff" },
  "Yuzu Study": { bg: "#fcf7ed", surface: "#f3e8d6", accent: "#a9743f" },
  "Ember Terminal": { bg: "#0a0b09", surface: "#273022", accent: "#a3e635" },
  "Twilight Amber": { bg: "#120d09", surface: "#3a281c", accent: "#ffb86b" },
};

function SettingsSection({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <section className="settings-card">
      <div className="settings-card-heading">
        <span className="settings-card-icon">{icon}</span>
        <div className="min-w-0">
          <div className="settings-card-title">{title}</div>
          <div className="settings-card-description">{description}</div>
        </div>
      </div>
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function SettingsField({ label, hint, children, wide = false }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={wide ? "settings-field settings-field-wide" : "settings-field"}>
      <span className="settings-field-label">{label}</span>
      {children}
      {hint && <span className="settings-field-hint">{hint}</span>}
    </label>
  );
}

function SettingsToggle({ checked, label, hint, onChange }: { checked: boolean; label: string; hint?: string; onChange: (checked: boolean) => void }) {
  return (
    <label className="settings-toggle-row">
      <span className="settings-toggle-copy">
        <span className="settings-toggle-label">{label}</span>
        {hint && <span className="settings-toggle-hint">{hint}</span>}
      </span>
      <input className="settings-toggle-input" type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="settings-toggle" aria-hidden="true"><span /></span>
    </label>
  );
}

export function SettingsPanel({ settings, language, onSave, onOpenData, dataDir, onNotify }: { settings: types.AppSettings; language: string; onSave: (settings: types.AppSettings) => void; onOpenData: () => void; dataDir: string; onNotify?: (text: string, tone?: "info" | "error" | "success") => void }) {
  const lang = language;
  const zh = lang === "zh-CN";
  const [draft, setDraft] = useState(new types.AppSettings(settings));
  const [mdMenu, setMdMenu] = useState(false);
  const update = (patch: Partial<types.AppSettings>) => setDraft((prev) => new types.AppSettings({ ...prev, ...patch }));
  const updateTerm = (patch: Partial<types.TerminalSettings>) => setDraft((prev) => new types.AppSettings({ ...prev, terminal: { ...prev.terminal, ...patch } }));

  useEffect(() => {
    setDraft(new types.AppSettings(settings));
  }, [settings]);

  // The right-click registration reflects live registry state, not settings.json.
  useEffect(() => {
    IsTextContextMenuRegistered().then(setMdMenu).catch(() => setMdMenu(false));
  }, []);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(settings), [draft, settings]);

  const toggleMdMenu = async (checked: boolean) => {
    try {
      if (checked) await RegisterTextContextMenu();
      else await UnregisterTextContextMenu();
      setMdMenu(checked);
    } catch (err) {
      onNotify?.(`${t(lang, "mdContextMenuFailed")}: ${String(err)}`, "error");
      IsTextContextMenuRegistered().then(setMdMenu).catch(() => {});
    }
  };

  const setAppTheme = (theme: string) => {
    const termTheme = draft.terminal.themeName;
    const syncedThemes = [draft.themeName, "gx Dark", ...appThemes];
    if (syncedThemes.includes(termTheme)) {
      setDraft((prev) => new types.AppSettings({ ...prev, themeName: theme, terminal: { ...prev.terminal, themeName: theme } }));
    } else {
      update({ themeName: theme });
    }
  };

  return (
    <div className="settings-page">
      <header className="settings-hero">
        <div className="settings-hero-icon"><Settings2 size={18} /></div>
        <div className="min-w-0 flex-1">
          <div className="settings-hero-title">{zh ? "偏好设置" : "Preferences"}</div>
          <div className="settings-hero-subtitle">{zh ? "调整外观、终端行为和本地集成" : "Tune appearance, terminal behavior and local integrations"}</div>
        </div>
        <button className="btn-primary settings-save" disabled={!dirty} onClick={() => onSave(draft)}><Save size={13} /> {t(lang, "save")}</button>
      </header>

      <div className="settings-sections">
        <SettingsSection icon={<Palette size={15} />} title={zh ? "外观" : "Appearance"} description={zh ? "应用主题、语言和整体视觉风格" : "App theme, language and visual style"}>
          <div className="settings-grid">
            <SettingsField label={t(lang, "lang")}>
              <select className="input compact-input" value={draft.language || "en"} onChange={(event) => update({ language: event.target.value })}><option value="en">English</option><option value="zh-CN">简体中文</option></select>
            </SettingsField>
            <SettingsField label={t(lang, "theme")}>
              <select className="input compact-input" value={normalizeAppTheme(draft.themeName)} onChange={(event) => setAppTheme(event.target.value)}>{appThemes.map((theme) => <option key={theme}>{theme}</option>)}</select>
            </SettingsField>
          </div>
          <div className="theme-picker" role="list" aria-label={t(lang, "theme")}>
            {appThemes.map((theme) => {
              const preview = themePreview[theme] || themePreview.Dark;
              const selected = normalizeAppTheme(draft.themeName) === theme;
              return (
                <button key={theme} type="button" className={selected ? "theme-choice theme-choice-active" : "theme-choice"} onClick={() => setAppTheme(theme)} title={theme}>
                  <span className="theme-choice-preview" style={{ background: preview.bg }}><span style={{ background: preview.surface }} /><i style={{ background: preview.accent }} /></span>
                  <span>{theme}</span>
                </button>
              );
            })}
          </div>
        </SettingsSection>

        <SettingsSection icon={<TerminalSquare size={15} />} title={zh ? "终端" : "Terminal"} description={zh ? "字体、颜色和输出显示方式" : "Typography, colors and output rendering"}>
          <div className="settings-grid">
            <SettingsField label={t(lang, "termTheme")}><select className="input compact-input" value={draft.terminal.themeName} onChange={(event) => updateTerm({ themeName: event.target.value })}>{Object.keys(terminalThemes).map((theme) => <option key={theme}>{theme}</option>)}</select></SettingsField>
            <SettingsField label={t(lang, "size")}><input className="input compact-input" type="number" min={9} max={30} value={draft.terminal.fontSize} onChange={(event) => updateTerm({ fontSize: Number(event.target.value) })} /></SettingsField>
            <SettingsField label={t(lang, "font")} wide><select className="input compact-input" value={draft.terminal.fontFamily} onChange={(event) => updateTerm({ fontFamily: event.target.value })}>{fontPresets.map((font) => <option key={font} value={font}>{font.split(",")[0].trim()}</option>)}</select></SettingsField>
            <SettingsField label={t(lang, "highlighting")} wide><select className="input compact-input" value={draft.highlightLevel || "off"} onChange={(event) => update({ highlightLevel: event.target.value })}><option value="off">{t(lang, "highlightOff")}</option><option value="basic">{t(lang, "highlightBasic")}</option><option value="full">{t(lang, "highlightFull")}</option></select></SettingsField>
            <SettingsField
              label={zh ? "本地 Shell" : "Local shell"}
              hint={zh ? "留空或填写 auto 自动选择；也可填写 pwsh.exe、cmd.exe、wsl.exe 或完整路径。下次新建本地终端生效。" : "Leave blank or use auto, or enter pwsh.exe, cmd.exe, wsl.exe, or a full executable path. Applies to new local terminals."}
              wide
            >
              <input className="input compact-input" value={draft.terminal.localShell || ""} placeholder="auto" onChange={(event) => updateTerm({ localShell: event.target.value })} />
            </SettingsField>
            <SettingsField
              label={zh ? "本地终端起始目录" : "Local start directory"}
              hint={zh ? "留空时使用用户主目录；支持 ~ 和环境变量。" : "Uses your home directory when blank; supports ~ and environment variables."}
              wide
            >
              <input className="input compact-input" value={draft.terminal.localStartDirectory || ""} placeholder="~" onChange={(event) => updateTerm({ localStartDirectory: event.target.value })} />
            </SettingsField>
          </div>
          <SettingsToggle checked={draft.smartHighlight !== false} onChange={(checked) => update({ smartHighlight: checked })} label={t(lang, "clickableLinks")} hint={t(lang, "clickableLinksHint")} />
        </SettingsSection>

        <SettingsSection icon={<Activity size={15} />} title={zh ? "连接与自动化" : "Connections & automation"} description={zh ? "监控频率、连接保护和 CLI 接入" : "Monitoring cadence, connection safeguards and CLI access"}>
          <div className="settings-grid settings-grid-three">
            <SettingsField label={t(lang, "monitorInterval")}><input className="input compact-input" type="number" min={1} value={draft.monitorIntervalSec} onChange={(event) => update({ monitorIntervalSec: Number(event.target.value) })} /></SettingsField>
            <SettingsField label={t(lang, "timeout")}><input className="input compact-input" type="number" min={1} value={draft.connectionTimeout} onChange={(event) => update({ connectionTimeout: Number(event.target.value) })} /></SettingsField>
          </div>
          <SettingsToggle checked={draft.monitorEnabled} onChange={(checked) => update({ monitorEnabled: checked })} label={t(lang, "enableMonitor")} />
          <SettingsToggle checked={draft.confirmOnDisconnect || false} onChange={(checked) => update({ confirmOnDisconnect: checked })} label={t(lang, "confirmClose")} />
          <SettingsToggle checked={draft.cliServerEnabled ?? true} onChange={(checked) => update({ cliServerEnabled: checked })} label={t(lang, "cliServerEnabled")} hint={t(lang, "cliServerEnabledHint")} />
        </SettingsSection>

        <SettingsSection icon={<ShieldCheck size={15} />} title={zh ? "系统集成" : "System integration"} description={zh ? "Windows 右键菜单和本地文件入口" : "Windows context menus and local file entry points"}>
          <SettingsToggle checked={mdMenu} onChange={toggleMdMenu} label={t(lang, "mdContextMenu")} hint={t(lang, "mdContextMenuHint")} />
        </SettingsSection>

        <SettingsSection icon={<Database size={15} />} title={zh ? "数据与信任" : "Data & trust"} description={zh ? "日志、历史记录和已信任主机" : "Logs, command history and trusted hosts"}>
          <div className="settings-action-grid">
            <button className="btn-secondary" onClick={onOpenData}><HardDrive size={13} /> {t(lang, "openData")}</button>
            <button className="btn-secondary" onClick={() => ExportHistory().catch(() => {})}><FileText size={13} /> {t(lang, "exportHistory")}</button>
          </div>
          <div className="settings-data-path"><HardDrive size={11} /><span>{dataDir}</span></div>
          <KnownHostsManager language={lang} onNotify={onNotify} />
        </SettingsSection>
      </div>
    </div>
  );
}
