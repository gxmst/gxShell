import type { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";

export function TerminalCompatibilityFields({ value, onChange, zh }: {
  value: types.TerminalSettings;
  onChange: (patch: Partial<types.TerminalSettings>) => void;
  zh: boolean;
}) {
  const language = zh ? "zh-CN" : "en";
  return <>
    <label className="settings-field">
      <span className="settings-field-label">{t(language, "terminalEncoding")}</span>
      <select className="input compact-input" value={value.encoding || "utf-8"} onChange={(event) => onChange({ encoding: event.target.value })}>
        <option value="utf-8">UTF-8</option>
        <option value="gbk">GBK / CP936</option>
        <option value="gb18030">GB18030</option>
        <option value="big5">Big5 / CP950</option>
        <option value="windows-1252">Windows-1252</option>
      </select>
    </label>
    <label className="settings-field">
      <span className="settings-field-label">{t(language, "terminalType")}</span>
      <select className="input compact-input" value={value.terminalType || "xterm-256color"} onChange={(event) => onChange({ terminalType: event.target.value })}>
        {["xterm-256color", "xterm", "vt100", "vt220", "ansi", "linux", "screen", "screen-256color", "dumb"].map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
    <label className="settings-field">
      <span className="settings-field-label">{t(language, "terminalBackspace")}</span>
      <select className="input compact-input" value={value.backspaceKey || "del"} onChange={(event) => onChange({ backspaceKey: event.target.value })}>
        <option value="del">DEL (0x7F)</option>
        <option value="ctrl-h">Ctrl+H (0x08)</option>
      </select>
    </label>
    <label className="settings-field">
      <span className="settings-field-label">{t(language, "terminalDelete")}</span>
      <select className="input compact-input" value={value.deleteKey || "escape"} onChange={(event) => onChange({ deleteKey: event.target.value })}>
        <option value="escape">ESC [ 3 ~</option>
        <option value="del">DEL (0x7F)</option>
        <option value="ctrl-h">Ctrl+H (0x08)</option>
      </select>
    </label>
    <p className="settings-field-wide settings-field-hint">{t(language, "terminalCompatibilityHint")}</p>
  </>;
}
