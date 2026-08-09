import { useState } from "react";
import { FileWarning, Save } from "lucide-react";
import { DialogHeader, ModalShell } from "./ModalShell";
import { t } from "../../i18n";

export function UnsavedChangesDialog({
  title,
  locale,
  body,
  onSave,
  onDiscard,
  onCancel,
}: {
  title: string;
  locale: string;
  /** Overrides the default document-oriented wording. */
  body?: string;
  onSave: () => Promise<boolean>;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const zh = locale === "zh-CN";

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const ok = await onSave();
      if (!ok) {
        setError(zh ? "保存失败，修改仍保留。" : "Save failed. Your changes are still here.");
        setSaving(false);
      }
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={() => { if (!saving) onCancel(); }} compact ariaLabel={zh ? "保存更改？" : "Save changes?"}>
      <DialogHeader
        icon={<FileWarning size={15} />}
        title={zh ? "保存更改？" : "Save changes?"}
        description={title}
      />
      <div className="dialog-body-copy">
        {body || (zh ? "此文档有尚未保存的修改。" : "This document has unsaved changes.")}
      </div>
      {error && <div className="profile-modal-error" role="alert">{error}</div>}
      <div className="dialog-footer">
        <button className="btn-secondary" disabled={saving} onClick={onCancel}>{t(locale, "cancel")}</button>
        <button className="btn-danger" disabled={saving} onClick={onDiscard}>{zh ? "不保存" : "Discard"}</button>
        <button className="btn-primary" disabled={saving} onClick={save}><Save size={13} /> {saving ? (zh ? "保存中…" : "Saving…") : t(locale, "save")}</button>
      </div>
    </ModalShell>
  );
}
