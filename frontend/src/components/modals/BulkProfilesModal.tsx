import { useMemo, useRef, useState } from "react";
import { ListChecks, Save, X } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ModalShell } from "./ModalShell";
import { ConfirmDialog } from "./ConfirmDialog";

export function BulkProfilesModal({ profiles, language, onClose, onSave }: { profiles: types.Profile[]; language: string; onClose: () => void; onSave: (ids: string[], patch: types.ProfileBatchPatch) => Promise<void> }) {
  const zh = language === "zh-CN";
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [patch, setPatch] = useState<types.ProfileBatchPatch>({ inheritTerminal: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [discard, setDiscard] = useState(false);
  const filtered = useMemo(() => profiles.filter((p) => `${p.name} ${p.host} ${p.group} ${p.username}`.toLowerCase().includes(query.trim().toLowerCase())), [profiles, query]);
  const changed = Object.keys(patch).some((key) => key !== "inheritTerminal" || patch.inheritTerminal);
  const close = () => { if (saving.current) return; if (changed) setDiscard(true); else onClose(); };
  const save = async () => {
    if (saving.current || !selected.length || !changed) return;
    saving.current = true; setBusy(true); setError("");
    try { await onSave(selected, patch); onClose(); } catch (err) { setError(String(err)); } finally { saving.current = false; setBusy(false); }
  };
  return <ModalShell onClose={close} ariaLabel={zh ? "批量修改服务器" : "Bulk edit servers"}>
    <div className="profile-modal-header"><h2 className="profile-modal-title flex items-center gap-2"><ListChecks size={16} />{zh ? "批量修改服务器" : "Bulk edit servers"}</h2><button className="icon-btn compact-icon" onClick={close} disabled={busy} title={zh ? "关闭" : "Close"}><X size={14} /></button></div>
    <input className="input compact-input" aria-label={zh ? "筛选服务器" : "Filter servers"} placeholder={zh ? "筛选服务器" : "Filter servers"} value={query} onChange={(e) => setQuery(e.target.value)} />
    <div className="flex items-center justify-between py-2 text-xs"><label className="check"><input type="checkbox" checked={filtered.length > 0 && filtered.every((p) => selected.includes(p.id))} ref={(el) => { if (el) el.indeterminate = filtered.some((p) => selected.includes(p.id)) && !filtered.every((p) => selected.includes(p.id)); }} onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...filtered.map((p) => p.id)])] : selected.filter((id) => !filtered.some((p) => p.id === id)))} />{zh ? "选择筛选结果" : "Select filtered"}</label><span>{zh ? `已选 ${selected.length} 台` : `${selected.length} selected`}</span></div>
    <div className="bulk-profile-list">{filtered.map((p) => <label key={p.id} className="bulk-profile-row"><input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id))} /><span><strong>{p.name || p.host}</strong><small>{p.group ? `${p.group} / ` : ""}{p.username}@{p.host}:{p.port}</small></span></label>)}{!filtered.length && <div className="panel-empty">{zh ? "没有匹配的服务器" : "No matching servers"}</div>}</div>
    <fieldset className="workbench-fields" disabled={busy}>
      {(["group", "username", "port"] as const).map((key) => <div key={key} className="bulk-field"><label className="check"><input type="checkbox" checked={patch[key] !== undefined} onChange={(e) => setPatch((prev) => { const next = { ...prev }; if (e.target.checked) Object.assign(next, { [key]: key === "port" ? 22 : "" }); else delete next[key]; return next; })} />{key === "group" ? (zh ? "修改分组" : "Change group") : key === "username" ? (zh ? "修改用户名" : "Change username") : (zh ? "修改端口" : "Change port")}</label><input className="input compact-input" disabled={patch[key] === undefined} aria-label={key} type={key === "port" ? "number" : "text"} min={key === "port" ? 1 : undefined} max={key === "port" ? 65535 : undefined} maxLength={256} value={patch[key] ?? ""} onChange={(e) => setPatch({ ...patch, [key]: key === "port" ? Number(e.target.value) : e.target.value })} /></div>)}
      {(["autoReconnect", "favorite"] as const).map((key) => <label key={key} className="bulk-field"><span>{key === "autoReconnect" ? (zh ? "自动重连" : "Auto reconnect") : (zh ? "收藏" : "Favorite")}</span><select className="input compact-input" value={patch[key] === undefined ? "unchanged" : String(patch[key])} onChange={(e) => setPatch((prev) => { const next = { ...prev }; if (e.target.value === "unchanged") delete next[key]; else next[key] = e.target.value === "true"; return next; })}><option value="unchanged">{zh ? "不修改" : "Unchanged"}</option><option value="true">{zh ? "开启" : "On"}</option><option value="false">{zh ? "关闭" : "Off"}</option></select></label>)}
      <label className="check"><input type="checkbox" checked={patch.inheritTerminal} onChange={(e) => setPatch({ ...patch, inheritTerminal: e.target.checked })} />{zh ? "恢复继承全局终端配置" : "Restore global terminal preferences"}</label>
    </fieldset>
    {error && <div className="profile-modal-error" role="alert">{error}</div>}
    <div className="profile-modal-footer"><span className="text-xs text-muted">{zh ? `应用到 ${selected.length} 台服务器` : `Apply to ${selected.length} servers`}</span><button className="btn-primary" disabled={busy || !selected.length || !changed || selected.length > 500} onClick={save}><Save size={14} />{busy ? (zh ? "正在保存" : "Saving") : (zh ? "保存修改" : "Save changes")}</button></div>
    {discard && <ConfirmDialog locale={language} title={zh ? "放弃修改？" : "Discard changes?"} body={zh ? "批量修改尚未保存。" : "Batch changes have not been saved."} confirmText={zh ? "放弃" : "Discard"} onClose={() => setDiscard(false)} onConfirm={onClose} />}
  </ModalShell>;
}
