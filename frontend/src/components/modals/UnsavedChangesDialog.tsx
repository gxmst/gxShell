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

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const ok = await onSave();
      if (!ok) {
        setError(t(locale, "unsavedSaveFailed"));
        setSaving(false);
      }
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  };

  return (
    <ModalShell onClose={() => { if (!saving) onCancel(); }} compact ariaLabel={t(locale, "unsavedSaveTitle")}>
      <DialogHeader
        icon={<FileWarning size={15} />}
        title={t(locale, "unsavedSaveTitle")}
        description={title}
      />
      <div className="dialog-body-copy">
        {body || t(locale, "unsavedBody")}
      </div>
      {error && <div className="profile-modal-error" role="alert">{error}</div>}
      <div className="dialog-footer">
        <button className="btn-secondary" disabled={saving} onClick={onCancel}>{t(locale, "cancel")}</button>
        <button className="btn-danger" disabled={saving} onClick={onDiscard}>{t(locale, "discardNoSave")}</button>
        <button className="btn-primary" disabled={saving} onClick={save}><Save size={13} /> {saving ? t(locale, "savingEllipsis") : t(locale, "save")}</button>
      </div>
    </ModalShell>
  );
}
