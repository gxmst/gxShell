import { useState } from "react";
import type { SecretRequest } from "../../types";
import { ModalShell, Label } from "./ModalShell";

export function SecretModal({ request, onSubmit, onClose }: { request: SecretRequest; onSubmit: (password: string, passphrase: string) => void; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [show, setShow] = useState(false);
  const isPassword = request.profile.authType === "password";
  return (
    <ModalShell onClose={onClose} compact>
      <div className="mb-3">
        <div className="text-sm font-semibold">{isPassword ? "Enter SSH password" : "Enter key passphrase"}</div>
        <div className="mt-1 truncate text-xs text-muted">{request.profile.username}@{request.profile.host}</div>
      </div>
      {isPassword ? (
        <Label text="Password">
          <input autoFocus className="input" type={show ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && password && onSubmit(password, "")} />
        </Label>
      ) : (
        <Label text="Private key passphrase">
          <input autoFocus className="input" type={show ? "text" : "password"} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onSubmit("", passphrase)} />
        </Label>
      )}
      <label className="check mt-3"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Show secret</label>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => onSubmit(password, passphrase)}>Connect</button>
      </div>
    </ModalShell>
  );
}

