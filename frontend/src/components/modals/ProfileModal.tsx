import { useState } from "react";
import { Copy, MoreHorizontal, Save, Trash2, X } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { ModalShell, Label } from "./ModalShell";

export function ProfileModal(props: { profile: types.Profile; language: string; onClose: () => void; onSave: (profile: types.Profile) => void; onPickKey: () => Promise<string>; onDelete: (id: string) => void; onDuplicate: (id: string) => void }) {
  const lang = props.language;
  const [draft, setDraft] = useState(new types.Profile(props.profile));
  const [error, setError] = useState("");
  const update = (patch: any) => { setError(""); setDraft(new types.Profile({ ...draft, ...patch })); };
  const handleSave = () => {
    if (!draft.host.trim()) { setError(t(lang, "hostRequired")); return; }
    if (!draft.username.trim()) { setError(t(lang, "usernameRequired")); return; }
    if (draft.port < 1 || draft.port > 65535) { setError(t(lang, "portRange")); return; }
    props.onSave(draft);
  };
  return (
    <ModalShell onClose={props.onClose}>
      <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">{draft.id ? t(lang, "editServer") : t(lang, "newServer")}</h2><button className="icon-btn" onClick={props.onClose}><X size={16} /></button></div>
      <div className="grid grid-cols-2 gap-3">
        <Label text={t(lang, "name")}><input className="input" value={draft.name} onChange={(e) => update({ name: e.target.value })} /></Label>
        <Label text={t(lang, "group")}><input className="input" value={draft.group} onChange={(e) => update({ group: e.target.value })} /></Label>
        <Label text={t(lang, "host")}><input className="input" value={draft.host} onChange={(e) => update({ host: e.target.value })} placeholder="e.g. 192.168.1.1" /></Label>
        <Label text={t(lang, "port")}><input className="input" type="number" value={draft.port} onChange={(e) => { const v = Number(e.target.value); update({ port: Number.isNaN(v) ? 22 : v }); }} /></Label>
        <Label text={t(lang, "username")}><input className="input" value={draft.username} onChange={(e) => update({ username: e.target.value })} /></Label>
        <Label text={t(lang, "auth")}><select className="input" value={draft.authType} onChange={(e) => update({ authType: e.target.value })}><option value="password">{t(lang, "password")}</option><option value="privateKey">{t(lang, "privateKey")}</option></select></Label>
        {draft.authType === "password" ? <Label text={t(lang, "password")}><input className="input" type="password" value={draft.password || ""} onChange={(e) => update({ password: e.target.value })} /></Label> : <>
          <Label text={t(lang, "privateKey")}><div className="flex gap-2"><input className="input" value={draft.privateKeyPath || ""} onChange={(e) => update({ privateKeyPath: e.target.value })} /><button className="icon-btn" onClick={async () => update({ privateKeyPath: await props.onPickKey() })}><MoreHorizontal size={15} /></button></div></Label>
          <Label text={t(lang, "passphrase")}><input className="input" type="password" value={draft.privateKeyPassphrase || ""} onChange={(e) => update({ privateKeyPassphrase: e.target.value })} /></Label>
        </>}
        <label className="check col-span-2"><input type="checkbox" checked={draft.favorite} onChange={(e) => update({ favorite: e.target.checked })} /> {t(lang, "favorite")}</label>
        <label className="check col-span-2"><input type="checkbox" checked={draft.rememberPassword || false} onChange={(e) => update({ rememberPassword: e.target.checked })} /> {t(lang, "savePassword")}</label>
        <Label text={t(lang, "description")}><textarea className="input min-h-[70px]" value={draft.description} onChange={(e) => update({ description: e.target.value })} /></Label>
      </div>
      {error && <div className="mt-2 text-xs" style={{ color: "var(--bad)" }}>{error}</div>}
      <div className="mt-4 flex justify-between">
        <div>{draft.id && <><button className="btn-danger" onClick={() => props.onDelete(draft.id)}><Trash2 size={15} /> {t(lang, "delete")}</button><button className="btn-secondary ml-2" onClick={() => props.onDuplicate(draft.id)}><Copy size={15} /> {t(lang, "duplicate")}</button></>}</div>
        <button className="btn-primary" onClick={handleSave}><Save size={15} /> {t(lang, "save")}</button>
      </div>
    </ModalShell>
  );
}

