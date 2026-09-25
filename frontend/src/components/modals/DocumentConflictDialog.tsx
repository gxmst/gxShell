import { AlertTriangle } from "lucide-react";
import { DialogHeader, ModalShell } from "./ModalShell";
import { t } from "../../i18n";

/**
 * Shown when a save finds the file on disk no longer matches what the editor
 * loaded.
 *
 * Three outcomes, because there are three things a user can reasonably want:
 * take the version on disk, keep their own version anyway, or leave the dialog
 * and reconcile by hand. A plain confirm/cancel would force the choice between
 * discarding their work and discarding the other change.
 */
export function DocumentConflictDialog({
  locale = "en",
  busy,
  onReload,
  onOverwrite,
  onKeepEditing,
}: {
  locale?: string;
  busy: boolean;
  /** Discard the draft and take the version now on disk. */
  onReload: () => void;
  /** Write the draft over the version now on disk. */
  onOverwrite: () => void | Promise<void>;
  /** Close the dialog and leave the draft alone. */
  onKeepEditing: () => void;
}) {
  return (
    <ModalShell onClose={() => { if (!busy) onKeepEditing(); }} compact ariaLabel={t(locale, "documentConflictTitle")}>
      <DialogHeader icon={<AlertTriangle size={15} />} title={t(locale, "documentConflictTitle")} />
      <div className="dialog-body-copy">{t(locale, "documentConflictBody")}</div>
      <div className="dialog-footer">
        <button className="btn-secondary" disabled={busy} onClick={onKeepEditing}>
          {t(locale, "documentConflictKeepEditing")}
        </button>
        <button className="btn-secondary" disabled={busy} onClick={onReload}>
          {t(locale, "documentConflictReload")}
        </button>
        <button className="btn-danger" disabled={busy} onClick={onOverwrite}>
          {busy ? t(locale, "loading") : t(locale, "documentConflictOverwrite")}
        </button>
      </div>
    </ModalShell>
  );
}
