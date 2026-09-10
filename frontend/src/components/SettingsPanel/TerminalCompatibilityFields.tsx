import type { types } from "../../../wailsjs/go/models";

export function TerminalCompatibilityFields({ value, onChange, zh }: {
  value: types.TerminalSettings;
  onChange: (patch: Partial<types.TerminalSettings>) => void;
  zh: boolean;
}) {
  return <>
    <label className="settings-field">
      <span className="settings-field-label">{zh ? "字符编码（SSH）" : "Character encoding (SSH)"}</span>
      <select className="input compact-input" value={value.encoding || "utf-8"} onChange={(event) => onChange({ encoding: event.target.value })}>
        <option value="utf-8">UTF-8</option>
        <option value="gbk">GBK / CP936</option>
        <option value="gb18030">GB18030</option>
        <option value="big5">Big5 / CP950</option>
        <option value="windows-1252">Windows-1252</option>
      </select>
    </label>
    <label className="settings-field">
      <span className="settings-field-label">{zh ? "终端类型（TERM）" : "Terminal type (TERM)"}</span>
      <select className="input compact-input" value={value.terminalType || "xterm-256color"} onChange={(event) => onChange({ terminalType: event.target.value })}>
        {["xterm-256color", "xterm", "vt100", "vt220", "ansi", "linux", "screen", "screen-256color", "dumb"].map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </label>
    <label className="settings-field">
      <span className="settings-field-label">{zh ? "退格键（Backspace）" : "Backspace key"}</span>
      <select className="input compact-input" value={value.backspaceKey || "del"} onChange={(event) => onChange({ backspaceKey: event.target.value })}>
        <option value="del">DEL (0x7F)</option>
        <option value="ctrl-h">Ctrl+H (0x08)</option>
      </select>
    </label>
    <label className="settings-field">
      <span className="settings-field-label">{zh ? "删除键（Delete）" : "Delete key"}</span>
      <select className="input compact-input" value={value.deleteKey || "escape"} onChange={(event) => onChange({ deleteKey: event.target.value })}>
        <option value="escape">ESC [ 3 ~</option>
        <option value="del">DEL (0x7F)</option>
        <option value="ctrl-h">Ctrl+H (0x08)</option>
      </select>
    </label>
    <p className="settings-field-wide settings-field-hint">{zh
      ? "编码和 TERM 在下次 SSH 连接时生效。按键设置立即生效；同步输入按每台服务器的设置发送。"
      : "Encoding and TERM apply on the next SSH connection. Key settings apply immediately; synchronized input uses each server’s preferences."}</p>
  </>;
}
