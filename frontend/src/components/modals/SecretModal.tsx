import { useState } from "react";
import { KeyRound } from "lucide-react";
import type { SecretRequest } from "../../types";
import { DialogHeader, ModalShell, Label } from "./ModalShell";
import { t } from "../../i18n";

export function SecretModal({ request, language, onSubmit, onClose }: { request: SecretRequest; language: string; onSubmit: (password: string, passphrase: string) => Promise<void>; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const isPassword = request.profile.authType === "password";
  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(password, passphrase);
    } catch (err) {
      setError(String(err));
      setSubmitting(false);
    }
  };
  return (
    <ModalShell onClose={() => { if (!submitting) onClose(); }} compact ariaLabel={isPassword ? t(language, "enterPassword") : t(language, "enterPassphrase")}>
      <DialogHeader icon={<KeyRound size={15} />} title={isPassword ? t(language, "enterPassword") : t(language, "enterPassphrase")} description={`${request.profile.username}@${request.profile.host}`} />
      {isPassword ? (
        <Label text={t(language, "password")}>
          <input autoFocus className="input" disabled={submitting} type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Label>
      ) : (
        <Label text={t(language, "passphrase")}>
          <input autoFocus className="input" disabled={submitting} type={show ? "text" : "password"} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Label>
      )}
      <label className="check mt-3"><input type="checkbox" disabled={submitting} checked={show} onChange={(e) => setShow(e.target.checked)} /> {t(language, "showSecret")}</label>
      {error && <div className="profile-modal-error mt-2" role="alert">{error}</div>}
      <div className="dialog-footer">
        <button className="btn-secondary" disabled={submitting} onClick={onClose}>{t(language, "cancel")}</button>
        <button className="btn-primary" disabled={submitting} onClick={submit}>{submitting ? (language === "zh-CN" ? "连接中…" : "Connecting…") : t(language, "connect")}</button>
      </div>
    </ModalShell>
  );
}
