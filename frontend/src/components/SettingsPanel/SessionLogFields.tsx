import type { types } from "../../../wailsjs/go/models";

export function SessionLogFields({ value, onChange, zh }: { value: types.SessionLogSettings; onChange: (value: types.SessionLogSettings) => void; zh: boolean }) {
  return <div className="workbench-fields">
    <label className="check"><input type="checkbox" checked={value.enabled} onChange={(e) => onChange({ ...value, enabled: e.target.checked })} />{zh ? "自动记录 SSH 输出（新连接生效）" : "Log SSH output automatically (new connections)"}</label>
    {value.enabled && <>
      <div className="text-xs text-muted">{zh ? "日志保存在本机，可能包含服务器输出的敏感内容。达到会话上限后停止记录，已有日志保留。" : "Local logs may contain sensitive server output. Logging stops at the session limit; existing logs are retained."}</div>
      <label className="check"><input type="checkbox" checked={value.timestamps} onChange={(e) => onChange({ ...value, timestamps: e.target.checked })} />{zh ? "行时间戳" : "Line timestamps"}</label>
      <div className="settings-grid">
        <label className="settings-field"><span>{zh ? "单文件上限 (MB)" : "File limit (MB)"}</span><input className="input compact-input" type="number" min={1} max={100} value={value.maxFileMb} onChange={(e) => onChange({ ...value, maxFileMb: Number(e.target.value) })} /></label>
        <label className="settings-field"><span>{zh ? "每次连接上限 (MB)" : "Connection limit (MB)"}</span><input className="input compact-input" type="number" min={value.maxFileMb} max={1024} value={value.maxSessionMb} onChange={(e) => onChange({ ...value, maxSessionMb: Number(e.target.value) })} /></label>
      </div>
    </>}
  </div>;
}
