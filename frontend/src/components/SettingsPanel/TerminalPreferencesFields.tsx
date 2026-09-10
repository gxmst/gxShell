import { types } from "../../../wailsjs/go/models";
import { fontPresets, terminalThemes, themeDisplayName } from "../../constants";
import { t } from "../../i18n";
import { normalizeFontSize, normalizeLineHeight, normalizeScrollbackLines } from "../../utils/terminalSettings";
import { TerminalCompatibilityFields } from "./TerminalCompatibilityFields";

export function TerminalPreferencesFields({ value, onChange, language }: { value: types.TerminalSettings; onChange: (value: types.TerminalSettings) => void; language: string }) {
  const update = (patch: Partial<types.TerminalSettings>) => onChange(new types.TerminalSettings({ ...value, ...patch }));
  return <div className="settings-grid">
    <label className="settings-field"><span>{t(language, "font")}</span><select className="input compact-input" value={value.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })}>{!fontPresets.includes(value.fontFamily) && <option value={value.fontFamily}>{value.fontFamily}</option>}{fontPresets.map((font) => <option key={font} value={font}>{font.split(",")[0]}</option>)}</select></label>
    <label className="settings-field"><span>{language === "zh-CN" ? "字号" : "Font size"}</span><input className="input compact-input" type="number" min={9} max={30} value={value.fontSize} onChange={(e) => update({ fontSize: Number(e.target.value) })} onBlur={() => update({ fontSize: normalizeFontSize(value.fontSize) })} /></label>
    <label className="settings-field"><span>{t(language, "lineHeightLabel")}</span><input className="input compact-input" type="number" min={1} max={2.5} step={0.05} value={value.lineHeight} onChange={(e) => update({ lineHeight: Number(e.target.value) })} onBlur={() => update({ lineHeight: normalizeLineHeight(value.lineHeight) })} /></label>
    <label className="settings-field"><span>{language === "zh-CN" ? "终端配色" : "Terminal theme"}</span><select className="input compact-input" value={value.themeName} onChange={(e) => update({ themeName: e.target.value })}>{Object.keys(terminalThemes).map((theme) => <option key={theme} value={theme}>{themeDisplayName(theme, language)}</option>)}</select></label>
    <label className="settings-field"><span>{t(language, "cursorStyleLabel")}</span><select className="input compact-input" value={value.cursorStyle} onChange={(e) => update({ cursorStyle: e.target.value })}><option value="block">{t(language, "cursorBlock")}</option><option value="bar">{t(language, "cursorBar")}</option><option value="underline">{t(language, "cursorUnderline")}</option></select></label>
    <label className="settings-field"><span>{t(language, "scrollbackLabel")}</span><input className="input compact-input" type="number" min={500} max={200000} step={500} value={value.scrollbackLines} onChange={(e) => update({ scrollbackLines: Number(e.target.value) })} onBlur={() => update({ scrollbackLines: normalizeScrollbackLines(value.scrollbackLines) })} /></label>
    <TerminalCompatibilityFields value={value} onChange={update} zh={language === "zh-CN"} />
    <label className="check"><input type="checkbox" checked={value.cursorBlink} onChange={(e) => update({ cursorBlink: e.target.checked })} />{t(language, "cursorBlinkLabel")}</label>
  </div>;
}
