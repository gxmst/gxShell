import type { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";

export function SessionLogFields({ value, onChange, zh }: { value: types.SessionLogSettings; onChange: (value: types.SessionLogSettings) => void; zh: boolean }) {
  const language = zh ? "zh-CN" : "en";
  return <div className="workbench-fields">
    <label className="check"><input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />{t(language, "sessionLogEnabled")}</label>
    {value.enabled && <>
      <div className="text-xs text-muted">{t(language, "sessionLogHint")}</div>
      <label className="check"><input type="checkbox" checked={value.timestamps} onChange={(e) => onChange({ ...value, timestamps: e.target.checked })} />{t(language, "sessionLogTimestamps")}</label>
      <div className="settings-grid">
        <label className="settings-field"><span>{t(language, "sessionLogFileLimit")}</span><input className="input compact-input" type="number" min={1} max={100} value={value.maxFileMb} onChange={(e) => onChange({ ...value, maxFileMb: Number(e.target.value) })} /></label>
        <label className="settings-field"><span>{t(language, "sessionLogConnectionLimit")}</span><input className="input compact-input" type="number" min={value.maxFileMb} max={1024} value={value.maxSessionMb} onChange={(e) => onChange({ ...value, maxSessionMb: Number(e.target.value) })} /></label>
      </div>
    </>}
  </div>;
}

export function SessionLogRetentionFields({ value, onChange, language }: {
  value: types.SessionLogRetentionSettings;
  onChange: (value: types.SessionLogRetentionSettings) => void;
  language: string;
}) {
  return <div className="workbench-fields">
    <label className="check"><input type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} />{t(language, "sessionLogRetentionEnabled")}</label>
    <p className="text-xs text-muted">{t(language, "sessionLogRetentionHint")}</p>
    {value.enabled && <div className="settings-grid">
      <label className="settings-field"><span>{t(language, "sessionLogRetentionDays")}</span><input className="input compact-input" type="number" min={1} max={3650} value={value.maxAgeDays} onChange={(event) => onChange({ ...value, maxAgeDays: Number(event.target.value) })} /></label>
      <label className="settings-field"><span>{t(language, "sessionLogRetentionSize")}</span><input className="input compact-input" type="number" min={1} max={102400} value={value.maxTotalMb} onChange={(event) => onChange({ ...value, maxTotalMb: Number(event.target.value) })} /></label>
    </div>}
  </div>;
}
