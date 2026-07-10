import { useState } from "react";
import { KeyRound } from "lucide-react";
import type { SecretRequest } from "../../types";
import { DialogHeader, ModalShell, Label } from "./ModalShell";
import { t } from "../../i18n";

export function SecretModal({ request, language, onSubmit, onClose }: { request: SecretRequest; language: string; onSubmit: (password: string, passphrase: string) => void; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [show, setShow] = useState(false);
  const isPassword = request.profile.authType === "password";
  return (
    <ModalShell onClose={onClose} compact>
      <DialogHeader icon={<KeyRound size={15} />} title={isPassword ? t(language, "enterPassword") : t(language, "enterPassphrase")} description={`${request.profile.username}@${request.profile.host}`} />
      {isPassword ? (
        <Label text={t(language, "password")}>
          <input autoFocus className="input" type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onSubmit(password, "")} />
        </Label>
      ) : (
        <Label text={t(language, "passphrase")}>
          <input autoFocus className="input" type={show ? "text" : "password"} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onSubmit("", passphrase)} />
        </Label>
      )}
      <label className="check mt-3"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> {t(language, "showSecret")}</label>
      <div className="dialog-footer">
        <button className="btn-secondary" onClick={onClose}>{t(language, "cancel")}</button>
        <button className="btn-primary" onClick={() => onSubmit(password, passphrase)}>{t(language, "connect")}</button>
      </div>
    </ModalShell>
  );
}
