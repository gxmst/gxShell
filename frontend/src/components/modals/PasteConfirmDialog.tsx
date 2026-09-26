import { ClipboardPaste, Radio } from "lucide-react";
import type { TerminalPasteRequest } from "../../hooks/useTerminal";
import { t } from "../../i18n";
import { ModalShell } from "./ModalShell";

export function PasteConfirmDialog({ request, language, onCancel, onConfirm }: {
  request: TerminalPasteRequest;
  language: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const lang = language;
  const targetLabel = request.broadcastTargets > 1
    ? t(lang, "pasteBroadcastTargets", { count: String(request.broadcastTargets) })
    : t(lang, "pasteCurrentTarget");

  return (
    <ModalShell
      compact
      priority={60}
      dismissOnBackdrop={false}
      ariaLabel={t(lang, "pasteConfirmTitle")}
      onClose={onCancel}
    >
      <div className="paste-confirm">
        <div className="paste-confirm-heading">
          <ClipboardPaste size={17} />
          <div>
            <strong>{t(lang, "pasteConfirmTitle")}</strong>
            <span>{t(lang, "pasteConfirmHint")}</span>
          </div>
        </div>
        <div className="paste-confirm-meta">
          <span>{t(lang, request.risk.lines === 1 ? "pasteLinesOne" : "pasteLinesMany", { count: String(request.risk.lines) })}</span>
          <span>{t(lang, "pasteCharCount", { count: String(request.risk.characters) })}</span>
          {request.broadcastTargets > 1 && <span className="paste-confirm-broadcast"><Radio size={12} /> {targetLabel}</span>}
        </div>
        {request.broadcastTargets <= 1 && <div className="paste-confirm-target">{targetLabel}</div>}
        <pre className="paste-confirm-preview">{request.risk.preview}</pre>
        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onCancel}>{t(lang, "cancel")}</button>
          <button className="btn-primary" onClick={onConfirm}><ClipboardPaste size={13} /> {t(lang, "pasteAnyway")}</button>
        </div>
      </div>
    </ModalShell>
  );
}

