import { useState } from "react";
import { Braces, Terminal } from "lucide-react";
import { DialogHeader, ModalShell, Label } from "./ModalShell";
import { fillPlaceholders } from "../../utils/commandVars";
import { t } from "../../i18n";

// Prompts the user to fill each <name> placeholder in a command template before
// it runs. Shows a live preview of the resolved command. Submits only when
// every placeholder has a value.
export function CommandVarsDialog({
  commandName,
  template,
  placeholders,
  locale,
  onSubmit,
  onClose,
}: {
  commandName: string;
  template: string;
  placeholders: string[];
  locale: string;
  onSubmit: (resolved: string) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const allFilled = placeholders.every((name) => (values[name] || "").trim() !== "");
  const preview = fillPlaceholders(template, values);

  const submit = () => {
    if (!allFilled) return;
    onSubmit(fillPlaceholders(template, values));
  };

  return (
    <ModalShell onClose={onClose} compact>
      <DialogHeader icon={<Braces size={15} />} title={commandName || t(locale, "cmd")} description={t(locale, "commandVarsHint")} />
      <div className="dialog-form compact">
        {placeholders.map((name, i) => (
          <Label key={name} text={name}>
            <input
              autoFocus={i === 0}
              className="input"
              value={values[name] || ""}
              placeholder={name}
              onChange={(e) => setValues((prev) => ({ ...prev, [name]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter" && allFilled) submit(); }}
            />
          </Label>
        ))}
      </div>
      <div className="dialog-code-preview">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted"><Terminal size={11} /> {t(locale, "commandPreview")}</div>
        <code className="block break-all font-mono text-[11.5px] text-text">{preview}</code>
      </div>
      <div className="dialog-footer">
        <button className="btn-secondary" onClick={onClose}>{t(locale, "cancel")}</button>
        <button className="btn-primary" disabled={!allFilled} onClick={submit}>{t(locale, "run")}</button>
      </div>
    </ModalShell>
  );
}
