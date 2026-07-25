import { Download } from "lucide-react";
import { BrowserOpenURL } from "../../../wailsjs/runtime/runtime";
import { version } from "../../../wailsjs/go/models";
import { DialogHeader, ModalShell } from "./ModalShell";
import { t } from "../../i18n";

// The update prompt. gxShell does not replace its own binary: the primary
// action opens the release page in the system browser and the user decides.
export function UpdateDialog({ result, locale = "en", onSkip, onClose }: { result: version.CheckResult; locale?: string; onSkip: (version: string) => void; onClose: () => void }) {
  const latest = result.latest;
  if (!latest) return null;

  return (
    <ModalShell onClose={onClose} compact>
      <DialogHeader icon={<Download size={15} />} title={t(locale, "updateTitle")} />
      <div className="dialog-body-copy">
        {t(locale, "updateAvailable", { version: latest.version })}
        <div className="text-xs opacity-70 mt-1">{t(locale, "updateCurrent")}: {result.current}</div>
      </div>
      {latest.notes && (
        <div className="update-notes">
          <div className="update-notes-title">{t(locale, "updateNotes")}</div>
          {/* Release notes are remote text, so they are rendered as a text node
              rather than through the Markdown pipeline. whitespace-pre-wrap
              keeps the author's line breaks without interpreting anything. */}
          <pre className="update-notes-body">{latest.notes}</pre>
        </div>
      )}
      <div className="dialog-footer">
        <button className="btn-secondary" onClick={() => onSkip(latest.version)}>{t(locale, "updateSkip")}</button>
        <button className="btn-secondary" onClick={onClose}>{t(locale, "updateLater")}</button>
        <button className="btn-primary" onClick={() => { BrowserOpenURL(latest.url); onClose(); }}>{t(locale, "updateOpenPage")}</button>
      </div>
    </ModalShell>
  );
}
