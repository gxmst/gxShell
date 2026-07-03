import { useState } from "react";
import { Terminal } from "lucide-react";
import { ModalShell, Label } from "./ModalShell";
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
      <div className="mb-1 text-sm font-semibold">{commandName || t(locale, "cmd")}</div>
      <div className="mb-3 text-[11px] text-muted">{t(locale, "commandVarsHint")}</div>
      <div className="space-y-2">
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
      <div className="mt-3 rounded-lg border border-border bg-[color-mix(in_srgb,var(--terminal)_60%,transparent)] px-2.5 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted"><Terminal size={11} /> {t(locale, "commandPreview")}</div>
        <code className="block break-all font-mono text-[11.5px] text-text">{preview}</code>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>{t(locale, "cancel")}</button>
        <button className="btn-primary" disabled={!allFilled} onClick={submit}>{t(locale, "run")}</button>
      </div>
    </ModalShell>
  );
}
