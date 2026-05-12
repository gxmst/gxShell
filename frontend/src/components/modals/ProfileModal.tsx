import { useState } from "react";
import { Copy, MoreHorizontal, Save, Trash2, X } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { ModalShell, Label } from "./ModalShell";

export function ProfileModal(props: { profile: types.Profile; onClose: () => void; onSave: (profile: types.Profile) => void; onPickKey: () => Promise<string>; onDelete: (id: string) => void; onDuplicate: (id: string) => void }) {
  const [draft, setDraft] = useState(new types.Profile(props.profile));
  const update = (patch: any) => setDraft(new types.Profile({ ...draft, ...patch }));
  return (
    <ModalShell onClose={props.onClose}>
      <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">{draft.id ? "Edit server" : "New server"}</h2><button className="icon-btn" onClick={props.onClose}><X size={16} /></button></div>
      <div className="grid grid-cols-2 gap-3">
        <Label text="Name"><input className="input" value={draft.name} onChange={(e) => update({ name: e.target.value })} /></Label>
        <Label text="Group"><input className="input" value={draft.group} onChange={(e) => update({ group: e.target.value })} /></Label>
        <Label text="Host"><input className="input" value={draft.host} onChange={(e) => update({ host: e.target.value })} /></Label>
        <Label text="Port"><input className="input" type="number" value={draft.port} onChange={(e) => { const v = Number(e.target.value); update({ port: Number.isNaN(v) ? 22 : v }); }} /></Label>
        <Label text="Username"><input className="input" value={draft.username} onChange={(e) => update({ username: e.target.value })} /></Label>
        <Label text="Auth"><select className="input" value={draft.authType} onChange={(e) => update({ authType: e.target.value })}><option value="password">Password</option><option value="privateKey">Private key</option></select></Label>
        {draft.authType === "password" ? <Label text="Password"><input className="input" type="password" value={draft.password || ""} onChange={(e) => update({ password: e.target.value })} /></Label> : <>
          <Label text="Private key"><div className="flex gap-2"><input className="input" value={draft.privateKeyPath || ""} onChange={(e) => update({ privateKeyPath: e.target.value })} /><button className="icon-btn" onClick={async () => update({ privateKeyPath: await props.onPickKey() })}><MoreHorizontal size={15} /></button></div></Label>
          <Label text="Passphrase"><input className="input" type="password" value={draft.privateKeyPassphrase || ""} onChange={(e) => update({ privateKeyPassphrase: e.target.value })} /></Label>
        </>}
        <label className="check col-span-2"><input type="checkbox" checked={draft.favorite} onChange={(e) => update({ favorite: e.target.checked })} /> Favorite</label>
        <label className="check col-span-2"><input type="checkbox" checked={draft.rememberPassword || false} onChange={(e) => update({ rememberPassword: e.target.checked })} /> Save password or passphrase in system credential store</label>
        <Label text="Description"><textarea className="input min-h-[70px]" value={draft.description} onChange={(e) => update({ description: e.target.value })} /></Label>
      </div>
      <div className="mt-4 flex justify-between">
        <div>{draft.id && <><button className="btn-danger" onClick={() => props.onDelete(draft.id)}><Trash2 size={15} /> Delete</button><button className="btn-secondary ml-2" onClick={() => props.onDuplicate(draft.id)}><Copy size={15} /> Duplicate</button></>}</div>
        <button className="btn-primary" onClick={() => props.onSave(draft)}><Save size={15} /> Save</button>
      </div>
    </ModalShell>
  );
}

