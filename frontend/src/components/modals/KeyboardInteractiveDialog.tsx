import { useState } from "react";
import { KeyRound } from "lucide-react";
import { DialogHeader, ModalShell } from "./ModalShell";
import { t } from "../../i18n";

export type KiRequest = {
  requestId: string;
  sessionId: string;
  name: string;
  instruction: string;
  prompts: string[];
  echos: boolean[];
};

// KeyboardInteractiveDialog answers a server's keyboard-interactive round
// (2FA/OTP, PAM challenges). The server may send any number of prompts; each is
// rendered as its own field. echos[i] === true means the input is not secret
// (e.g. a visible OTP label) and is shown as plain text; otherwise it is masked.
export function KeyboardInteractiveDialog({ request, language, onSubmit, onCancel }: { request: KiRequest; language: string; onSubmit: (answers: string[]) => void; onCancel: () => void }) {
  const lang = language;
  const [answers, setAnswers] = useState<string[]>(() => request.prompts.map(() => ""));

  const setAnswer = (idx: number, value: string) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[idx] = value;
      return next;
    });
  };

  const submit = () => onSubmit(answers);

  return (
    <ModalShell onClose={onCancel} compact ariaLabel={request.name || t(lang, "kiTitle")}>
      <div className="space-y-3">
        <DialogHeader icon={<KeyRound size={15} />} title={request.name || t(lang, "kiTitle")} description={request.instruction || undefined} />
        {request.prompts.map((prompt, idx) => (
          <div key={idx} className="space-y-1">
            <div className="text-[11px] text-muted whitespace-pre-wrap">{prompt}</div>
            <input
              autoFocus={idx === 0}
              type={request.echos[idx] ? "text" : "password"}
              className="input"
              value={answers[idx]}
              onChange={(e) => setAnswer(idx, e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && idx === request.prompts.length - 1) submit(); }}
            />
          </div>
        ))}
        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onCancel}>{t(lang, "kiCancel")}</button>
          <button className="btn-primary" onClick={submit}>{t(lang, "kiSubmit")}</button>
        </div>
      </div>
    </ModalShell>
  );
}
