import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Activity, Database, Download, FileText, HardDrive, Palette, RefreshCw, Save, Search, Settings2, ShieldCheck, TerminalSquare, X } from "lucide-react";
import { CheckForUpdate, ExportHistory, GetVersion, IsTextContextMenuRegistered, RegisterTextContextMenu, UnregisterTextContextMenu } from "../../../wailsjs/go/app/App";
import { BrowserOpenURL } from "../../../wailsjs/runtime/runtime";
import { types, version as versionModel } from "../../../wailsjs/go/models";
import { appThemes, fontPresets, terminalThemes } from "../../constants";
import { normalizeAppTheme } from "../../utils/format";
import { normalizeFontSize, normalizeLineHeight, normalizeScrollbackLines } from "../../utils/terminalSettings";
import { t } from "../../i18n";
import { KnownHostsManager } from "./KnownHostsManager";

const themePreview: Record<string, { bg: string; surface: string; accent: string }> = {
  Light: { bg: "#e8edf4", surface: "#f8fafd", accent: "#2563eb" },
  Dark: { bg: "#0e1217", surface: "#212a35", accent: "#4d90d6" },
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

export function SettingsPanel({ settings, language, onSave, onOpenData, dataDir, onNotify, onDirtyChange }: { settings: types.AppSettings; language: string; onSave: (settings: types.AppSettings) => void | Promise<void>; onOpenData: () => void; dataDir: string; onNotify?: (text: string, tone?: "info" | "error" | "success") => void; onDirtyChange?: (dirty: boolean, save: () => Promise<boolean>) => void }) {
  const lang = language;
  const zh = lang === "zh-CN";
  const [draft, setDraft] = useState(new types.AppSettings(settings));
  const [settingsQuery, setSettingsQuery] = useState("");
  const settingsPageRef = useRef<HTMLDivElement>(null);
  const [mdMenu, setMdMenu] = useState(false);
  // The manual update check is local to this panel: the startup check lives in
  // useUpdateCheck and raises a dialog, while this one only reports inline.
  const [updateResult, setUpdateResult] = useState<versionModel.CheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  const update = (patch: Partial<types.AppSettings>) => setDraft((prev) => new types.AppSettings({ ...prev, ...patch }));
  const updateTerm = (patch: Partial<types.TerminalSettings>) => setDraft((prev) => new types.AppSettings({ ...prev, terminal: { ...prev.terminal, ...patch } }));

  useEffect(() => {
    setDraft(new types.AppSettings(settings));
  }, [settings]);

  // The right-click registration reflects live registry state, not settings.json.
  useEffect(() => {
    IsTextContextMenuRegistered().then(setMdMenu).catch(() => setMdMenu(false));
  }, []);

  useEffect(() => {
    GetVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, []);

  const normalizedDraft = useMemo(() => {
    const fontSize = normalizeFontSize(draft.terminal.fontSize);
    const lineHeight = normalizeLineHeight(draft.terminal.lineHeight);
    const scrollbackLines = normalizeScrollbackLines(draft.terminal.scrollbackLines);
    if (fontSize === draft.terminal.fontSize && lineHeight === draft.terminal.lineHeight && scrollbackLines === draft.terminal.scrollbackLines) return draft;
    return new types.AppSettings({ ...draft, terminal: { ...draft.terminal, fontSize, lineHeight, scrollbackLines } });
  }, [draft]);
  const dirty = useMemo(
    () => JSON.stringify(new types.AppSettings(draft)) !== JSON.stringify(new types.AppSettings(settings)),
    [draft, settings],
  );

  // Resolves to whether the write actually landed, so the unsaved-changes
  // prompt can keep itself open on failure instead of discarding the edits.
  const commit = useCallback(async () => {
    if (!dirty) return true;
    try {
      await onSave(normalizedDraft);
      return true;
    } catch (err) {
      onNotify?.(String(err), "error");
      return false;
    }
  }, [dirty, normalizedDraft, onSave, onNotify]);

  // Publish the dirty state upward so closing or switching the drawer can stop
  // and ask instead of silently dropping the edits. The save closure is passed
  // along with it so the host does not need its own copy of the draft.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const dirtyCallbackRef = useRef(onDirtyChange);
  dirtyCallbackRef.current = onDirtyChange;
  useEffect(() => {
    dirtyCallbackRef.current?.(dirty, () => commitRef.current());
  }, [dirty]);
  // Clearing on unmount keeps a stale "unsaved settings" guard from blocking
  // navigation after the panel is gone.
  useEffect(() => () => dirtyCallbackRef.current?.(false, async () => true), []);

  // Ctrl+S is the reflex for a form with a Save button. Bound on the panel
  // subtree rather than the window so it cannot shadow a terminal's Ctrl+S.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void commit();
    }
  };

  // Search stays additive: it does not remove controls or change their order.
  // The first matching field is brought into view and receives a transient
  // outline, which makes a long settings page feel like a searchable index.
  useEffect(() => {
    const root = settingsPageRef.current;
    if (!root) return;
    const query = settingsQuery.trim().toLocaleLowerCase();
    const candidates = Array.from(root.querySelectorAll<HTMLElement>(
      ".settings-field, .settings-toggle-row, .theme-choice, .settings-card",
    ));
    candidates.forEach((element) => element.classList.remove("settings-search-match", "settings-search-dim"));
    if (!query) return;
    const fields = candidates.filter((element) => !element.classList.contains("settings-card"));
    const matches = fields.filter((element) => (element.textContent || "").toLocaleLowerCase().includes(query));
    const targets = matches.length ? matches : candidates.filter((element) => (element.textContent || "").toLocaleLowerCase().includes(query));
    if (!targets.length) return;
    targets[0].classList.add("settings-search-match");
    targets[0].scrollIntoView?.({ block: "center", behavior: "smooth" });
    if (matches.length) {
      fields.filter((element) => !matches.includes(element)).forEach((element) => element.classList.add("settings-search-dim"));
    }
    const clear = window.setTimeout(() => targets[0]?.classList.remove("settings-search-match"), 1800);
    return () => window.clearTimeout(clear);
  }, [settingsQuery]);

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

  // The manual check reports whatever it finds, including "up to date" and
  // failures. That is the difference from the startup check, which stays quiet
  // unless there is something to act on: here the user asked, so silence would
  // read as a broken button.
  const runUpdateCheck = useCallback(async () => {
    setChecking(true);
    try {
      setUpdateResult(await CheckForUpdate());
    } catch (err) {
      onNotify?.(t(lang, "updateFailed", { reason: String(err) }), "error");
    } finally {
      setChecking(false);
    }
  }, [lang, onNotify]);

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
    <div className="settings-page" ref={settingsPageRef} onKeyDown={onKeyDown}>
      <header className="settings-hero">
        <div className="settings-hero-icon"><Settings2 size={18} /></div>
        <div className="min-w-0 flex-1">
          <div className="settings-hero-title">{zh ? "偏好设置" : "Preferences"}</div>
          <div className="settings-hero-subtitle">
            {dirty
              ? <span className="settings-dirty-note">{t(lang, "unsavedChangesHint")}</span>
              : (zh ? "调整外观、终端行为和本地集成" : "Tune appearance, terminal behavior and local integrations")}
          </div>
        </div>
        <div className="settings-search" role="search">
          <Search size={13} aria-hidden="true" />
          <input
            className="input settings-search-input"
            value={settingsQuery}
            onChange={(event) => setSettingsQuery(event.currentTarget.value)}
            placeholder={t(lang, "searchPlaceholder")}
            aria-label={t(lang, "search")}
            spellCheck={false}
          />
          {settingsQuery && (
            <button type="button" className="settings-search-clear" onClick={() => setSettingsQuery("")} aria-label={t(lang, "close")} title={t(lang, "close")}>
              <X size={12} />
            </button>
          )}
        </div>
        <button className={dirty ? "btn-primary settings-save settings-save-dirty" : "btn-primary settings-save"} disabled={!dirty} onClick={() => void commit()} title="Ctrl+S">
          <Save size={13} /> {dirty ? t(lang, "saveChanges") : t(lang, "save")}
        </button>
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
            <SettingsField label={t(lang, "size")}><input className="input compact-input" type="number" min={9} max={30} value={draft.terminal.fontSize} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) updateTerm({ fontSize: value }); }} onBlur={() => updateTerm({ fontSize: normalizeFontSize(draft.terminal.fontSize) })} /></SettingsField>
            <SettingsField label={t(lang, "lineHeightLabel")}>
              <input
                className="input compact-input"
                type="number"
                min={1}
                max={2.5}
                step={0.05}
                value={draft.terminal.lineHeight}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(value)) updateTerm({ lineHeight: value });
                }}
                onBlur={() => updateTerm({ lineHeight: normalizeLineHeight(draft.terminal.lineHeight) })}
              />
            </SettingsField>
            <SettingsField label={t(lang, "cursorStyleLabel")}>
              <select className="input compact-input" value={draft.terminal.cursorStyle || "block"} onChange={(event) => updateTerm({ cursorStyle: event.target.value })}>
                <option value="block">{t(lang, "cursorBlock")}</option>
                <option value="bar">{t(lang, "cursorBar")}</option>
                <option value="underline">{t(lang, "cursorUnderline")}</option>
              </select>
            </SettingsField>
            <SettingsField label={t(lang, "scrollbackLabel")} hint={t(lang, "scrollbackHint")} wide>
              <input
                className="input compact-input"
                type="number"
                min={500}
                max={200000}
                step={500}
                value={draft.terminal.scrollbackLines}
                onChange={(event) => {
                  const value = event.currentTarget.valueAsNumber;
                  if (Number.isFinite(value)) updateTerm({ scrollbackLines: value });
                }}
                onBlur={() => updateTerm({ scrollbackLines: normalizeScrollbackLines(draft.terminal.scrollbackLines) })}
              />
            </SettingsField>
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
          <SettingsToggle checked={draft.terminal.cursorBlink} onChange={(checked) => updateTerm({ cursorBlink: checked })} label={t(lang, "cursorBlinkLabel")} />
          <SettingsToggle checked={draft.smartHighlight !== false} onChange={(checked) => update({ smartHighlight: checked })} label={t(lang, "clickableLinks")} hint={t(lang, "clickableLinksHint")} />
        </SettingsSection>

        <SettingsSection icon={<Activity size={15} />} title={zh ? "连接与自动化" : "Connections & automation"} description={zh ? "监控频率、连接保护和 CLI 接入" : "Monitoring cadence, connection safeguards and CLI access"}>
          <div className="settings-grid settings-grid-three">
            <SettingsField label={t(lang, "monitorInterval")}><input className="input compact-input" type="number" min={1} value={draft.monitorIntervalSec} onChange={(event) => update({ monitorIntervalSec: Number(event.target.value) })} /></SettingsField>
            <SettingsField label={t(lang, "timeout")}><input className="input compact-input" type="number" min={1} value={draft.connectionTimeout} onChange={(event) => update({ connectionTimeout: Number(event.target.value) })} /></SettingsField>
          </div>
          <SettingsToggle checked={draft.monitorEnabled} onChange={(checked) => update({ monitorEnabled: checked })} label={t(lang, "enableMonitor")} />
          <SettingsToggle checked={draft.confirmOnDisconnect || false} onChange={(checked) => update({ confirmOnDisconnect: checked })} label={t(lang, "confirmClose")} />
          <SettingsToggle
            checked={draft.restoreWorkspace || false}
            onChange={(checked) => update({ restoreWorkspace: checked })}
            label={zh ? "恢复上次工作区" : "Restore last workspace"}
            hint={zh ? "启动时重新连接上次仍打开的服务器；最多同时恢复 3 个连接。" : "Reconnect servers that were still open at exit, with at most 3 concurrent restores."}
          />
          <SettingsToggle checked={draft.cliServerEnabled ?? false} onChange={(checked) => update({ cliServerEnabled: checked })} label={t(lang, "cliServerEnabled")} hint={t(lang, "cliServerEnabledHint")} />
        </SettingsSection>

        <SettingsSection icon={<ShieldCheck size={15} />} title={zh ? "系统集成" : "System integration"} description={zh ? "Windows 右键菜单和本地文件入口" : "Windows context menus and local file entry points"}>
          <SettingsToggle checked={mdMenu} onChange={toggleMdMenu} label={t(lang, "mdContextMenu")} hint={t(lang, "mdContextMenuHint")} />
        </SettingsSection>

        <SettingsSection icon={<Download size={15} />} title={t(lang, "updateSection")} description={t(lang, "updateSectionDesc")}>
          <SettingsToggle checked={draft.updateCheckEnabled ?? false} onChange={(checked) => update({ updateCheckEnabled: checked })} label={t(lang, "updateCheckEnabled")} hint={t(lang, "updateCheckEnabledHint")} />
          <div className="settings-action-grid">
            <button className="btn-secondary" onClick={runUpdateCheck} disabled={checking}>
              <RefreshCw size={13} className={checking ? "animate-spin" : ""} /> {checking ? t(lang, "updateChecking") : t(lang, "updateCheckNow")}
            </button>
            {updateResult?.latest?.url && updateResult.updateAvailable && (
              <button className="btn-secondary" onClick={() => BrowserOpenURL(updateResult.latest!.url)}>
                <Download size={13} /> {t(lang, "updateOpenPage")}
              </button>
            )}
          </div>
          <div className="settings-data-path">
            <span>{t(lang, "updateCurrent")}: {updateResult?.current || appVersion}</span>
          </div>
          {updateResult && (
            <div className="settings-field-hint">
              {updateResult.error
                ? t(lang, "updateFailed", { reason: updateResult.error })
                : updateResult.updateAvailable && updateResult.latest
                  ? t(lang, "updateAvailable", { version: updateResult.latest.version })
                  : t(lang, "updateUpToDate")}
            </div>
          )}
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
