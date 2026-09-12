import { useState } from "react";
import { FolderOpen, Pencil, Plus, Save, Square, Trash2, X } from "lucide-react";
import type { useNamedWorkspaces } from "../../hooks/useNamedWorkspaces";
import { ModalShell } from "./ModalShell";
import { ConfirmDialog } from "./ConfirmDialog";
import { SecretModal } from "./SecretModal";
import { t } from "../../i18n";

export function WorkspacesModal({ manager, language, eligible, excluded, onClose }: { manager: ReturnType<typeof useNamedWorkspaces>; language: string; eligible: number; excluded: number; onClose: () => void }) {
  const [name, setName] = useState("");
  const [renameId, setRenameId] = useState("");
  const [error, setError] = useState(manager.storageError);
  const [issues, setIssues] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: () => void } | null>(null);
  const attempt = (action: () => void) => { try { action(); setError(""); } catch (err) { setError(String(err)); } };
  const close = () => { if (!manager.busy) onClose(); };
  return <ModalShell onClose={close} ariaLabel={t(language, "workspacesTitle")}>
    <div className="profile-modal-header"><h2 className="profile-modal-title">{t(language, "workspacesTitle")}</h2><button className="icon-btn compact-icon" disabled={manager.busy} title={t(language, "workspacesClose")} onClick={close}><X size={14} /></button></div>
    <div className="workspace-name-row"><input className="input compact-input" aria-label={t(language, "workspacesName")} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} disabled={manager.busy} placeholder={t(language, "workspacesName")} /><button className="btn-primary" disabled={manager.busy || !name.trim() || (!renameId && !eligible)} onClick={() => attempt(() => { if (renameId) manager.rename(renameId, name); else manager.snapshot(name); setName(""); setRenameId(""); })}>{renameId ? <Save size={14} /> : <Plus size={14} />}{renameId ? (t(language, "workspacesRename")) : (t(language, "workspacesSaveCurrent"))}</button>{renameId && <button className="icon-btn compact-icon" title={t(language, "workspacesCancelRename")} onClick={() => { setRenameId(""); setName(""); }}><X size={14} /></button>}</div>
    <div className="text-xs text-muted py-2">{t(language, "workspacesEligible", { count: String(eligible) })}{excluded > 0 && (t(language, "workspacesExcluded", { count: String(excluded) }))}</div>
    <div className="workspace-saved-list">{manager.workspaces.map((w) => <div className="workspace-saved-row" key={w.id}>
      <button className="workspace-open" disabled={manager.busy} title={t(language, "workspacesOpen")} onClick={async () => { setIssues([]); setError(""); try { const result = await manager.open(w); if (result === null) return; if (result.length) setIssues(result); else onClose(); } catch (err) { setError(String(err)); } }}><FolderOpen size={15} /><span><strong>{w.name}</strong><small>{w.items.length} {t(language, "workspacesItems")}{w.layout ? ` / ${w.layout.keys.length} ${t(language, "workspacesPanes")}` : ""}</small></span></button>
      <button className="icon-btn compact-icon" disabled={manager.busy} title={t(language, "workspacesRename")} onClick={() => { setRenameId(w.id); setName(w.name); }}><Pencil size={13} /></button>
      <button className="icon-btn compact-icon" disabled={manager.busy || !eligible} title={t(language, "workspacesUpdate")} onClick={() => setConfirm({ title: t(language, "workspacesUpdateConfirm"), body: w.name, action: () => manager.snapshot(w.name, w.id) })}><Save size={13} /></button>
      <button className="icon-btn compact-icon" disabled={manager.busy} title={t(language, "workspacesDelete")} onClick={() => setConfirm({ title: t(language, "workspacesDeleteConfirm"), body: w.name, action: () => manager.remove(w.id) })}><Trash2 size={13} /></button>
    </div>)}{!manager.workspaces.length && <div className="panel-empty">{t(language, "workspacesEmpty")}</div>}</div>
    {manager.busy && <div className="flex items-center justify-between gap-2 py-2 text-xs"><span role="status">{t(language, "workspacesOpening")}{manager.progress}</span><button className="btn-secondary" onClick={manager.cancel}><Square size={12} />{t(language, "workspacesStop")}</button></div>}
    {error && <div className="profile-modal-error" role="alert">{error}</div>}
    {!!issues.length && <div className="workspace-issues" role="alert">{issues.map((issue, index) => <div key={index}>{issue}</div>)}</div>}
    {confirm && <ConfirmDialog locale={language} title={confirm.title} body={confirm.body} confirmText={t(language, "workspacesConfirm")} onClose={() => setConfirm(null)} onConfirm={() => { attempt(confirm.action); setConfirm(null); }} />}
    {manager.secretPrompt && <SecretModal key={manager.secretPrompt.profile.id} request={{ profile: manager.secretPrompt.profile, mode: "connect" }} language={language} onClose={manager.secretPrompt.cancel} onSubmit={manager.secretPrompt.submit} />}
  </ModalShell>;
}
