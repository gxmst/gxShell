import { useMemo, useState } from "react";
import { KeyRound, MoreHorizontal, PlugZap } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";
import { DialogHeader, Label, ModalShell } from "./ModalShell";

export function QuickConnectModal(props: {
  language: string;
  onClose: () => void;
  onPickKey: () => Promise<string>;
  onConnect: (profile: types.Profile, saveProfile: boolean) => Promise<void>;
}) {
  const lang = props.language;
  const rememberedUser = useMemo(() => {
    try { return localStorage.getItem("gx:quickConnectUser") || "root"; } catch { return "root"; }
  }, []);
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState(rememberedUser);
  const [authType, setAuthType] = useState("password");
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [saveProfile, setSaveProfile] = useState(false);
  const [rememberSecret, setRememberSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    const cleanHost = host.trim();
    const cleanUser = username.trim();
    if (!cleanHost) { setError(t(lang, "hostRequired")); return; }
    if (!cleanUser) { setError(t(lang, "usernameRequired")); return; }
    if (port < 1 || port > 65535) { setError(t(lang, "portRange")); return; }
    if (authType === "password" && !password) { setError(t(lang, "enterPassword")); return; }
    if (authType === "privateKey" && !privateKeyPath.trim()) { setError(t(lang, "privateKeyRequired")); return; }
    const profile = new types.Profile({
      id: saveProfile ? "" : `quick-${crypto.randomUUID()}`,
      name: `${cleanUser}@${cleanHost}`,
      group: saveProfile ? "Quick" : "",
      host: cleanHost,
      port,
      username: cleanUser,
      authType,
      password: authType === "password" ? password : "",
      privateKeyPath: authType === "privateKey" ? privateKeyPath.trim() : "",
      privateKeyPassphrase: authType === "privateKey" ? passphrase : "",
      rememberPassword: saveProfile && rememberSecret,
      proxyJumpId: "",
      description: "",
      tags: [],
      favorite: false,
      cliEnabled: false,
      cliAlias: "",
      tunnels: [],
      autoReconnect: false,
    });
    setBusy(true);
    setError("");
    try {
      try { localStorage.setItem("gx:quickConnectUser", cleanUser); } catch {}
      await props.onConnect(profile, saveProfile);
      props.onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={() => { if (!busy) props.onClose(); }} compact>
      <DialogHeader
        icon={<PlugZap size={16} />}
        title={t(lang, "quickConnect")}
        description={t(lang, "quickConnectHint")}
      />
      <div className="profile-modal-grid quick-connect-grid">
        <Label text={t(lang, "host")}><input autoFocus className="input compact-input" value={host} onChange={(event) => setHost(event.target.value)} placeholder="192.168.1.10" onKeyDown={(event) => { if (event.key === "Enter") submit(); }} /></Label>
        <Label text={t(lang, "port")}><input className="input compact-input" type="number" value={port} onChange={(event) => setPort(Number(event.target.value) || 22)} /></Label>
        <Label text={t(lang, "username")}><input className="input compact-input" value={username} onChange={(event) => setUsername(event.target.value)} /></Label>
        <Label text={t(lang, "auth")}><select className="input compact-input" value={authType} onChange={(event) => setAuthType(event.target.value)}><option value="password">{t(lang, "password")}</option><option value="privateKey">{t(lang, "privateKey")}</option><option value="agent">{t(lang, "authAgent")}</option></select></Label>
        {authType === "password" && <Label text={t(lang, "password")}><input className="input compact-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") submit(); }} /></Label>}
        {authType === "privateKey" && <>
          <Label text={t(lang, "privateKey")}><div className="flex gap-1"><input className="input compact-input" value={privateKeyPath} onChange={(event) => setPrivateKeyPath(event.target.value)} /><button className="icon-btn compact-icon" onClick={async () => { const selected = await props.onPickKey(); if (selected) setPrivateKeyPath(selected); }} title={t(lang, "privateKey")}><MoreHorizontal size={13} /></button></div></Label>
          <Label text={t(lang, "passphrase")}><input className="input compact-input" type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></Label>
        </>}
        {authType === "agent" && <div className="col-span-2 text-[10px] text-muted leading-snug"><KeyRound size={11} className="inline mr-1" />{t(lang, "authAgentHint")}</div>}
        <label className="check col-span-2"><input type="checkbox" checked={saveProfile} onChange={(event) => { setSaveProfile(event.target.checked); if (!event.target.checked) setRememberSecret(false); }} /> {t(lang, "saveConnection")}</label>
        {saveProfile && authType !== "agent" && <label className="check col-span-2"><input type="checkbox" checked={rememberSecret} onChange={(event) => setRememberSecret(event.target.checked)} /> {t(lang, "savePassword")}</label>}
      </div>
      {error && <div className="profile-modal-error">{error}</div>}
      <div className="profile-modal-footer">
        <button className="btn-secondary" disabled={busy} onClick={props.onClose}>{t(lang, "cancel")}</button>
        <button className="btn-primary" disabled={busy} onClick={submit}><PlugZap size={13} /> {busy ? t(lang, "connecting") : (saveProfile ? t(lang, "saveAndConnect") : t(lang, "connectOnce"))}</button>
      </div>
    </ModalShell>
  );
}
