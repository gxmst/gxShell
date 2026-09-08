import { useState } from "react";
import { FolderOpen, Pencil, Plus, Save, Square, Trash2, X } from "lucide-react";
import type { useNamedWorkspaces } from "../../hooks/useNamedWorkspaces";
import { ModalShell } from "./ModalShell";
import { ConfirmDialog } from "./ConfirmDialog";
import { SecretModal } from "./SecretModal";

export function WorkspacesModal({ manager, language, eligible, excluded, onClose }: { manager: ReturnType<typeof useNamedWorkspaces>; language: string; eligible: number; excluded: number; onClose: () => void }) {
  const zh = language === "zh-CN";
  const [name, setName] = useState("");
  const [renameId, setRenameId] = useState("");
  const [error, setError] = useState(manager.storageError);
  const [issues, setIssues] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: () => void } | null>(null);
  const attempt = (action: () => void) => { try { action(); setError(""); } catch (err) { setError(String(err)); } };
  const close = () => { if (!manager.busy) onClose(); };
  return <ModalShell onClose={close} ariaLabel={zh ? "工作区" : "Workspaces"}>
    <div className="profile-modal-header"><h2 className="profile-modal-title">{zh ? "工作区" : "Workspaces"}</h2><button className="icon-btn compact-icon" disabled={manager.busy} title={zh ? "关闭" : "Close"} onClick={close}><X size={14} /></button></div>
    <div className="workspace-name-row"><input className="input compact-input" aria-label={zh ? "工作区名称" : "Workspace name"} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} disabled={manager.busy} placeholder={zh ? "工作区名称" : "Workspace name"} /><button className="btn-primary" disabled={manager.busy || !name.trim() || (!renameId && !eligible)} onClick={() => attempt(() => { if (renameId) manager.rename(renameId, name); else manager.snapshot(name); setName(""); setRenameId(""); })}>{renameId ? <Save size={14} /> : <Plus size={14} />}{renameId ? (zh ? "重命名" : "Rename") : (zh ? "保存当前" : "Save current")}</button>{renameId && <button className="icon-btn compact-icon" title={zh ? "取消重命名" : "Cancel rename"} onClick={() => { setRenameId(""); setName(""); }}><X size={14} /></button>}</div>
    <div className="text-xs text-muted py-2">{zh ? `当前可保存 ${eligible} 个项目` : `${eligible} items in the current workspace`}{excluded > 0 && (zh ? `；${excluded} 个临时连接、远程文件或本地终端未包含` : `; ${excluded} temporary connections, remote files or local terminals excluded`)}</div>
    <div className="workspace-saved-list">{manager.workspaces.map((w) => <div className="workspace-saved-row" key={w.id}>
      <button className="workspace-open" disabled={manager.busy} title={zh ? "打开工作区" : "Open workspace"} onClick={async () => { setIssues([]); setError(""); try { const result = await manager.open(w); if (result.length) setIssues(result); else onClose(); } catch (err) { setError(String(err)); } }}><FolderOpen size={15} /><span><strong>{w.name}</strong><small>{w.items.length} {zh ? "个项目" : "items"}{w.layout ? ` / ${w.layout.keys.length} ${zh ? "窗格" : "panes"}` : ""}</small></span></button>
      <button className="icon-btn compact-icon" disabled={manager.busy} title={zh ? "重命名" : "Rename"} onClick={() => { setRenameId(w.id); setName(w.name); }}><Pencil size={13} /></button>
      <button className="icon-btn compact-icon" disabled={manager.busy || !eligible} title={zh ? "用当前标签更新工作区" : "Update from current tabs"} onClick={() => setConfirm({ title: zh ? "更新工作区？" : "Update workspace?", body: w.name, action: () => manager.snapshot(w.name, w.id) })}><Save size={13} /></button>
      <button className="icon-btn compact-icon" disabled={manager.busy} title={zh ? "删除工作区" : "Delete workspace"} onClick={() => setConfirm({ title: zh ? "删除工作区？" : "Delete workspace?", body: w.name, action: () => manager.remove(w.id) })}><Trash2 size={13} /></button>
    </div>)}{!manager.workspaces.length && <div className="panel-empty">{zh ? "尚无工作区" : "No saved workspaces"}</div>}</div>
    {manager.busy && <div className="flex items-center justify-between gap-2 py-2 text-xs"><span role="status">{zh ? "正在打开：" : "Opening: "}{manager.progress}</span><button className="btn-secondary" onClick={manager.cancel}><Square size={12} />{zh ? "停止" : "Stop"}</button></div>}
    {error && <div className="profile-modal-error" role="alert">{error}</div>}
    {!!issues.length && <div className="workspace-issues" role="alert">{issues.map((issue, index) => <div key={index}>{issue}</div>)}</div>}
    {confirm && <ConfirmDialog locale={language} title={confirm.title} body={confirm.body} confirmText={zh ? "确认" : "Confirm"} onClose={() => setConfirm(null)} onConfirm={() => { attempt(confirm.action); setConfirm(null); }} />}
    {manager.secretPrompt && <SecretModal key={manager.secretPrompt.profile.id} request={{ profile: manager.secretPrompt.profile, mode: "connect" }} language={language} onClose={manager.secretPrompt.cancel} onSubmit={manager.secretPrompt.submit} />}
  </ModalShell>;
}
