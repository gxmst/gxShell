import { useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import type { types } from "../../../wailsjs/go/models";
import { findHighlightMatches, highlightRuleError } from "../../utils/highlight";

export function HighlightRulesEditor({ rules, onChange, zh }: { rules: types.HighlightRule[]; onChange: (rules: types.HighlightRule[]) => void; zh: boolean }) {
  const [sample, setSample] = useState("ERROR connection refused 192.168.1.10");
  const update = (index: number, patch: Partial<types.HighlightRule>) => onChange(rules.map((r, i) => i === index ? { ...r, ...patch } : r));
  const move = (index: number, delta: number) => {
    const next = [...rules];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange(next);
  };
  const matches = findHighlightMatches(sample, "off", rules);
  const fragments = [];
  let offset = 0;
  for (const [index, match] of matches.entries()) {
    fragments.push(<span key={`p${index}`}>{sample.slice(offset, match.start)}</span>, <span key={`m${index}`} style={{ color: match.color }}>{sample.slice(match.start, match.end)}</span>);
    offset = match.end;
  }
  fragments.push(<span key="tail">{sample.slice(offset)}</span>);
  return <div className="workbench-fields">
    <div className="flex items-center justify-between gap-2"><strong>{zh ? "自定义高亮" : "Custom highlighting"}</strong><button className="icon-btn compact-icon" title={zh ? "添加规则" : "Add rule"} disabled={rules.length >= 20} onClick={() => onChange([...rules, { id: crypto.randomUUID(), pattern: "", mode: "literal", color: "#e85656", enabled: true, caseSensitive: false }])}><Plus size={14} /></button></div>
    {rules.map((rule, index) => <div key={rule.id}>
      <div className="highlight-rule-row">
        <input type="checkbox" aria-label={zh ? "启用规则" : "Enable rule"} checked={rule.enabled} onChange={(e) => update(index, { enabled: e.target.checked })} />
        <input className="input compact-input" aria-label={zh ? "匹配内容" : "Pattern"} maxLength={256} value={rule.pattern} onChange={(e) => update(index, { pattern: e.target.value })} />
        <select className="input compact-input" aria-label={zh ? "匹配方式" : "Match mode"} value={rule.mode} onChange={(e) => update(index, { mode: e.target.value as "literal" | "regex" })}><option value="literal">{zh ? "文本" : "Text"}</option><option value="regex">RE2</option></select>
        <input type="color" aria-label={zh ? "颜色" : "Color"} value={rule.color} onChange={(e) => update(index, { color: e.target.value })} />
        <label className="check highlight-rule-case" title={zh ? "区分大小写" : "Case sensitive"}><input type="checkbox" aria-label={zh ? "区分大小写" : "Case sensitive"} checked={rule.caseSensitive} onChange={(e) => update(index, { caseSensitive: e.target.checked })} />Aa</label>
        <div className="highlight-rule-actions">
          <button className="icon-btn compact-icon" title={zh ? "上移" : "Move up"} disabled={!index} onClick={() => move(index, -1)}><ArrowUp size={12} /></button>
          <button className="icon-btn compact-icon" title={zh ? "下移" : "Move down"} disabled={index === rules.length - 1} onClick={() => move(index, 1)}><ArrowDown size={12} /></button>
          <button className="icon-btn compact-icon" title={zh ? "删除规则" : "Delete rule"} onClick={() => onChange(rules.filter((_, i) => i !== index))}><Trash2 size={12} /></button>
        </div>
      </div>
      {highlightRuleError(rule) && <div className="text-bad text-xs" role="alert">{highlightRuleError(rule)}</div>}
    </div>)}
    {!!rules.length && <><label className="settings-field"><span>{zh ? "预览文本" : "Preview text"}</span><input className="input compact-input" maxLength={512} value={sample} onChange={(e) => setSample(e.target.value)} /></label><pre className="highlight-preview">{fragments}</pre></>}
  </div>;
}
