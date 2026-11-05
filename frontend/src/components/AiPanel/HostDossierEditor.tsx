import { useEffect, useRef, useState } from "react";
import { GetAiHostDossier, SaveAiHostDossier, DeleteAiHostDossier } from "../../../wailsjs/go/app/App";
import type { DossierInput, HostDossier } from "../../../wailsjs/go/workflow";
import { t } from "../../i18n";

export function HostDossierEditor({ profileId, locale, onError, onSaved, sourceRunId, sourceUnknownId, suggestedNote = "" }: {
  profileId: string; locale: string; onError: (message: string) => void; onSaved?: (dossier: HostDossier) => void;
  sourceRunId?: string; sourceUnknownId?: string; suggestedNote?: string;
}) {
  const [dossier, setDossier] = useState<HostDossier>();
  const [draft, setDraft] = useState<DossierInput>();
  const [services, setServices] = useState("");
  const [ports, setPorts] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [saved, setSaved] = useState(false);
  const errorCallback = useRef(onError); errorCallback.current = onError;
  useEffect(() => {
    let disposed = false;
    setDraft(undefined); setDossier(undefined); setSaved(false);
    if (!profileId) return;
    GetAiHostDossier(profileId).then((value) => {
      if (disposed || !value) return;
      setDossier(value);
      setDraft({ revision: value.revision || 0, purpose: value.purpose || "", environment: value.environment || "",
        services: value.services || [], ports: value.ports || [], containerRuntime: value.containerRuntime || "unknown",
        notes: [value.notes, suggestedNote].filter(Boolean).join("\n"), sourceRunId, sourceUnknownId });
      setServices((value.services || []).join(", ")); setPorts((value.ports || []).join(", "));
    }).catch((error) => { if (!disposed) errorCallback.current(String(error)); });
    return () => { disposed = true; };
  }, [profileId, sourceRunId, sourceUnknownId, suggestedNote, reload]);
  const persist = async (clear = false) => {
    if (!draft || busy) return;
    const names = [...new Set(services.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean))];
    const portNames = [...new Set(ports.split(/[,，\n]/).map((p) => p.trim()).filter(Boolean))];
    if (!clear && (names.some((n) => !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/.test(n)) || portNames.some((p) => !/^\d+$/.test(p) || Number(p) < 1 || Number(p) > 65535))) { onError(t(locale, "inspectionHostInvalid")); return; }
    setBusy(true); setSaved(false);
    try {
      const value = await (clear ? DeleteAiHostDossier(profileId, draft.revision) : SaveAiHostDossier(profileId, { ...draft, services: names, ports: portNames.map(Number) }));
      setDossier(value); setDraft({ revision: value.revision, purpose: value.purpose || "", environment: value.environment || "",
        services: value.services || [], ports: value.ports || [], containerRuntime: value.containerRuntime || "unknown", notes: value.notes || "", sourceRunId, sourceUnknownId });
      setServices((value.services || []).join(", ")); setPorts((value.ports || []).join(", "));
      setSaved(true); onSaved?.(value);
    } catch (error) { onError(String(error)); } finally { setBusy(false); }
  };
  if (!profileId) return null;
  return <div className="inspection-dossier-editor">
    <p className="inspection-report-empty">{t(locale, "inspectionHostDossierNote")}</p>
    <button className="btn-secondary" disabled={busy} onClick={() => setReload((value) => value + 1)}>{t(locale, "inspectionHostReload")}</button>
    {draft && <fieldset disabled={busy}>
      <label>{t(locale, "inspectionHostPurpose")}<input className="input" value={draft.purpose} maxLength={250} onChange={(e) => setDraft({ ...draft, purpose: e.target.value })} /></label>
      <label>{t(locale, "inspectionHostEnvironment")}<input className="input" value={draft.environment} maxLength={60} onChange={(e) => setDraft({ ...draft, environment: e.target.value })} /></label>
      <label>{t(locale, "inspectionHostServices")}<input className="input" value={services} onChange={(e) => setServices(e.target.value)} maxLength={512} placeholder="nginx.service, ssh.service" /></label>
      <label>{t(locale, "inspectionHostPorts")}<input className="input" value={ports} onChange={(e) => setPorts(e.target.value)} maxLength={100} placeholder="22, 443" /></label>
      <label>{t(locale, "inspectionHostContainers")}<select className="input" aria-label={t(locale, "inspectionHostContainers")} value={draft.containerRuntime} onChange={(e) => setDraft({ ...draft, containerRuntime: e.target.value })}>
        <option value="unknown">{t(locale, "inspectionHostUnknown")}</option><option value="none">{t(locale, "inspectionHostNone")}</option>
        <option value="docker">Docker</option><option value="podman">Podman</option><option value="other">{t(locale, "inspectionHostOther")}</option>
      </select></label>
      <label>{t(locale, "inspectionHostNotes")}<textarea className="input" value={draft.notes} maxLength={600} rows={3} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
      <div className="inspection-report-actions"><button className="btn-secondary" onClick={() => persist()}>{t(locale, "inspectionHostSave")}</button>
        <button className="btn-secondary" onClick={() => persist(true)} disabled={!dossier?.revision || dossier.deleted}>{t(locale, "inspectionHostClear")}</button></div>
    </fieldset>}
    {saved && <p role="status">{t(locale, "inspectionHostSaved")}</p>}
    {!!dossier?.revision && <small>v{dossier.revision} · {dossier.reviewer} · {new Date(dossier.updatedAt).toLocaleString(locale)}</small>}
    {!!dossier?.history?.length && <details><summary>{t(locale, "inspectionHostHistory")} ({dossier.history.length})</summary>
      {dossier.history.map((revision) => <p key={revision.revision}>v{revision.revision} · {revision.reviewer} · {new Date(revision.updatedAt).toLocaleString(locale)}<br />{revision.purpose}<br />{revision.notes}</p>)}
    </details>}
  </div>;
}
