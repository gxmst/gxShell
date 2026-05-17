import { useState } from "react";
import { Copy, MoreHorizontal, Plus, Save, Trash2, X } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { ModalShell, Label } from "./ModalShell";

export function ProfileModal(props: { profile: types.Profile; profiles: types.Profile[]; language: string; onClose: () => void; onSave: (profile: types.Profile) => void; onPickKey: () => Promise<string>; onDelete: (id: string) => void; onDuplicate: (id: string) => void }) {
  const lang = props.language;
  const [draft, setDraft] = useState(new types.Profile(props.profile));
  const [error, setError] = useState("");
  const update = (patch: any) => { setError(""); setDraft(new types.Profile({ ...draft, ...patch })); };

  const addTunnel = () => {
    const rule = types.TunnelRule.createFrom({
      id: crypto.randomUUID(),
      type: "local",
      local: "127.0.0.1:0",
      remote: "127.0.0.1:0",
      bindHost: "",
    });
    update({ tunnels: [...(draft.tunnels || []), rule] });
  };

  const updateTunnel = (idx: number, patch: Partial<types.TunnelRule>) => {
    const list = [...(draft.tunnels || [])];
    list[idx] = types.TunnelRule.createFrom({ ...list[idx], ...patch });
    update({ tunnels: list });
  };

  const removeTunnel = (idx: number) => {
    const list = [...(draft.tunnels || [])];
    list.splice(idx, 1);
    update({ tunnels: list });
  };

  const handleSave = () => {
    if (!draft.host.trim()) { setError(t(lang, "hostRequired")); return; }
    if (!draft.username.trim()) { setError(t(lang, "usernameRequired")); return; }
    if (draft.port < 1 || draft.port > 65535) { setError(t(lang, "portRange")); return; }
    props.onSave(draft);
  };
  return (
    <ModalShell onClose={props.onClose}>
      <div className="profile-modal-header">
        <h2 className="profile-modal-title">{draft.id ? t(lang, "editServer") : t(lang, "newServer")}</h2>
        <button className="icon-btn compact-icon" onClick={props.onClose}><X size={14} /></button>
      </div>
      <div className="profile-modal-grid">
        <Label text={t(lang, "name")}><input className="input compact-input" value={draft.name} onChange={(e) => update({ name: e.target.value })} /></Label>
        <Label text={t(lang, "group")}><input className="input compact-input" value={draft.group} onChange={(e) => update({ group: e.target.value })} /></Label>
        <Label text={t(lang, "host")}><input className="input compact-input" value={draft.host} onChange={(e) => update({ host: e.target.value })} placeholder="e.g. 192.168.1.1" /></Label>
        <Label text={t(lang, "port")}><input className="input compact-input" type="number" value={draft.port} onChange={(e) => { const v = Number(e.target.value); update({ port: Number.isNaN(v) ? 22 : v }); }} /></Label>
        <Label text={t(lang, "username")}><input className="input compact-input" value={draft.username} onChange={(e) => update({ username: e.target.value })} /></Label>
        <Label text={t(lang, "auth")}><select className="input compact-input" value={draft.authType} onChange={(e) => update({ authType: e.target.value })}><option value="password">{t(lang, "password")}</option><option value="privateKey">{t(lang, "privateKey")}</option></select></Label>
        {draft.authType === "password" ? <Label text={t(lang, "password")}><input className="input compact-input" type="password" value={draft.password || ""} onChange={(e) => update({ password: e.target.value })} /></Label> : <>
          <Label text={t(lang, "privateKey")}><div className="flex gap-1"><input className="input compact-input" value={draft.privateKeyPath || ""} onChange={(e) => update({ privateKeyPath: e.target.value })} /><button className="icon-btn compact-icon" onClick={async () => update({ privateKeyPath: await props.onPickKey() })}><MoreHorizontal size={13} /></button></div></Label>
          <Label text={t(lang, "passphrase")}><input className="input compact-input" type="password" value={draft.privateKeyPassphrase || ""} onChange={(e) => update({ privateKeyPassphrase: e.target.value })} /></Label>
        </>}
        <Label text={t(lang, "proxyJump")}><select className="input compact-input" value={draft.proxyJumpId || ""} onChange={(e) => update({ proxyJumpId: e.target.value })}><option value="">— {t(lang, "none")} —</option>{(props.profiles || []).filter((p) => p.id !== draft.id && !p.proxyJumpId).map((p) => <option key={p.id} value={p.id}>{p.name} ({p.host})</option>)}</select></Label>
        <label className="check col-span-2"><input type="checkbox" checked={draft.favorite} onChange={(e) => update({ favorite: e.target.checked })} /> {t(lang, "favorite")}</label>
        <label className="check col-span-2"><input type="checkbox" checked={draft.rememberPassword || false} onChange={(e) => update({ rememberPassword: e.target.checked })} /> {t(lang, "savePassword")}</label>
        <label className="check col-span-2"><input type="checkbox" checked={draft.autoReconnect || false} onChange={(e) => update({ autoReconnect: e.target.checked })} /> {t(lang, "autoReconnect")}</label>
        <Label text={t(lang, "description")}><textarea className="input compact-input min-h-[56px]" value={draft.description} onChange={(e) => update({ description: e.target.value })} /></Label>
      </div>

      <div className="profile-modal-tunnel-header">
        <span className="profile-modal-tunnel-title">{t(lang, "tunnelRules")}</span>
        <button className="icon-btn compact-icon" onClick={addTunnel} title={t(lang, "addTunnel")}><Plus size={12} /></button>
      </div>
      {(!draft.tunnels || draft.tunnels.length === 0) && (
        <div className="profile-modal-tunnel-empty">{t(lang, "noTunnels")}</div>
      )}
      {(draft.tunnels || []).map((rule, idx) => (
        <div key={rule.id || idx} className="profile-modal-tunnel-row">
          <select className="input compact-input col-span-3 text-[10px]" value={rule.type} onChange={(e) => updateTunnel(idx, { type: e.target.value })}>
            <option value="local">{t(lang, "tunnelLocal")}</option>
            <option value="remote">{t(lang, "tunnelRemote")}</option>
            <option value="dynamic">{t(lang, "tunnelDynamic")}</option>
          </select>
          <input className="input compact-input col-span-3 text-[10px] font-mono" value={rule.local} placeholder="127.0.0.1:8080" onChange={(e) => updateTunnel(idx, { local: e.target.value })} />
          <span className="text-[9px] text-center" style={{ color: "var(--muted)" }}>→</span>
          <input className="input compact-input col-span-3 text-[10px] font-mono" value={rule.remote} placeholder="127.0.0.1:80" onChange={(e) => updateTunnel(idx, { remote: e.target.value })} />
          <input className="input compact-input col-span-1 text-[10px] font-mono" value={rule.bindHost || ""} placeholder="0.0.0.0" onChange={(e) => updateTunnel(idx, { bindHost: e.target.value })} title={t(lang, "tunnelBindHost")} />
          <button className="icon-btn compact-icon col-span-1" onClick={() => removeTunnel(idx)} title={t(lang, "removeTunnel")}><Trash2 size={11} /></button>
        </div>
      ))}

      {error && <div className="profile-modal-error">{error}</div>}
      <div className="profile-modal-footer">
        <div>{draft.id && <><button className="btn-danger" onClick={() => props.onDelete(draft.id)}><Trash2 size={13} /> {t(lang, "delete")}</button><button className="btn-secondary ml-2" onClick={() => props.onDuplicate(draft.id)}><Copy size={13} /> {t(lang, "duplicate")}</button></>}</div>
        <button className="btn-primary" onClick={handleSave}><Save size={13} /> {t(lang, "save")}</button>
      </div>
    </ModalShell>
  );
}
