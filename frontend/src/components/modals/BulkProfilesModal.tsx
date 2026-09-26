import { useMemo, useRef, useState } from "react";
import { ListChecks, Save, X } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { ModalShell } from "./ModalShell";
import { ConfirmDialog } from "./ConfirmDialog";

export function BulkProfilesModal({ profiles, language, onClose, onSave }: { profiles: types.Profile[]; language: string; onClose: () => void; onSave: (ids: string[], patch: types.ProfileBatchPatch) => Promise<void> }) {
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
  return <ModalShell onClose={close} ariaLabel={t(language, "bulkEditServers")}>
    <div className="profile-modal-header"><h2 className="profile-modal-title flex items-center gap-2"><ListChecks size={16} />{t(language, "bulkEditServers")}</h2><button className="icon-btn compact-icon" onClick={close} disabled={busy} title={t(language, "close")}><X size={14} /></button></div>
    <input className="input compact-input" aria-label={t(language, "bulkFilterServers")} placeholder={t(language, "bulkFilterServers")} value={query} onChange={(e) => setQuery(e.target.value)} />
    <div className="flex items-center justify-between py-2 text-xs"><label className="check"><input type="checkbox" checked={filtered.length > 0 && filtered.every((p) => selected.includes(p.id))} ref={(el) => { if (el) el.indeterminate = filtered.some((p) => selected.includes(p.id)) && !filtered.every((p) => selected.includes(p.id)); }} onChange={(e) => setSelected(e.target.checked ? [...new Set([...selected, ...filtered.map((p) => p.id)])] : selected.filter((id) => !filtered.some((p) => p.id === id)))} />{t(language, "bulkSelectFiltered")}</label><span>{t(language, "bulkSelectedCount", { count: String(selected.length) })}</span></div>
    <div className="bulk-profile-list">{filtered.map((p) => <label key={p.id} className="bulk-profile-row"><input type="checkbox" checked={selected.includes(p.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id))} /><span><strong>{p.name || p.host}</strong><small>{p.group ? `${p.group} / ` : ""}{p.username}@{p.host}:{p.port}</small></span></label>)}{!filtered.length && <div className="panel-empty">{t(language, "bulkNoMatchingServers")}</div>}</div>
    <fieldset className="workbench-fields" disabled={busy}>
      {(["group", "username", "port"] as const).map((key) => <div key={key} className="bulk-field"><label className="check"><input type="checkbox" checked={patch[key] !== undefined} onChange={(e) => setPatch((prev) => { const next = { ...prev }; if (e.target.checked) Object.assign(next, { [key]: key === "port" ? 22 : "" }); else delete next[key]; return next; })} />{key === "group" ? t(language, "bulkChangeGroup") : key === "username" ? t(language, "bulkChangeUsername") : t(language, "bulkChangePort")}</label><input className="input compact-input" disabled={patch[key] === undefined} aria-label={key} type={key === "port" ? "number" : "text"} min={key === "port" ? 1 : undefined} max={key === "port" ? 65535 : undefined} maxLength={256} value={patch[key] ?? ""} onChange={(e) => setPatch({ ...patch, [key]: key === "port" ? Number(e.target.value) : e.target.value })} /></div>)}
      {(["autoReconnect", "favorite"] as const).map((key) => <label key={key} className="bulk-field"><span>{key === "autoReconnect" ? t(language, "autoReconnect") : t(language, "favorite")}</span><select className="input compact-input" value={patch[key] === undefined ? "unchanged" : String(patch[key])} onChange={(e) => setPatch((prev) => { const next = { ...prev }; if (e.target.value === "unchanged") delete next[key]; else next[key] = e.target.value === "true"; return next; })}><option value="unchanged">{t(language, "bulkUnchanged")}</option><option value="true">{t(language, "bulkOn")}</option><option value="false">{t(language, "bulkOff")}</option></select></label>)}
      <label className="check"><input type="checkbox" checked={patch.inheritTerminal} onChange={(e) => setPatch({ ...patch, inheritTerminal: e.target.checked })} />{t(language, "bulkRestoreGlobalTerminal")}</label>
    </fieldset>
    {error && <div className="profile-modal-error" role="alert">{error}</div>}
    <div className="profile-modal-footer"><span className="text-xs text-muted">{t(language, "bulkApplyTo", { count: String(selected.length) })}</span><button className="btn-primary" disabled={busy || !selected.length || !changed || selected.length > 500} onClick={save}><Save size={14} />{busy ? t(language, "saving") : t(language, "saveChanges")}</button></div>
    {discard && <ConfirmDialog locale={language} title={t(language, "bulkDiscardTitle")} body={t(language, "bulkDiscardBody")} confirmText={t(language, "discardNoSave")} onClose={() => setDiscard(false)} onConfirm={onClose} />}
  </ModalShell>;
}
