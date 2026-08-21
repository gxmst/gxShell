import { ClipboardPaste, Radio } from "lucide-react";
import type { TerminalPasteRequest } from "../../hooks/useTerminal";
import { ModalShell } from "./ModalShell";

export function PasteConfirmDialog({ request, language, onCancel, onConfirm }: {
  request: TerminalPasteRequest;
  language: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const zh = language === "zh-CN";
  const targetLabel = request.broadcastTargets > 1
    ? (zh ? `将发送到 ${request.broadcastTargets} 个终端` : `Will be sent to ${request.broadcastTargets} terminals`)
    : (zh ? "将发送到当前终端" : "Will be sent to the current terminal");

  return (
    <ModalShell
      compact
      priority={60}
      dismissOnBackdrop={false}
      ariaLabel={zh ? "确认粘贴到终端" : "Confirm terminal paste"}
      onClose={onCancel}
    >
      <div className="paste-confirm">
        <div className="paste-confirm-heading">
          <ClipboardPaste size={17} />
          <div>
            <strong>{zh ? "确认粘贴到终端" : "Confirm terminal paste"}</strong>
            <span>{zh ? "多行或较长文本可能立即执行命令。" : "Multiline or long text may execute commands immediately."}</span>
          </div>
        </div>
        <div className="paste-confirm-meta">
          <span>{request.risk.lines} {zh ? "行" : request.risk.lines === 1 ? "line" : "lines"}</span>
          <span>{request.risk.characters} {zh ? "字符" : "characters"}</span>
          {request.broadcastTargets > 1 && <span className="paste-confirm-broadcast"><Radio size={12} /> {targetLabel}</span>}
        </div>
        {request.broadcastTargets <= 1 && <div className="paste-confirm-target">{targetLabel}</div>}
        <pre className="paste-confirm-preview">{request.risk.preview}</pre>
        <div className="dialog-actions">
          <button className="btn-secondary" onClick={onCancel}>{zh ? "取消" : "Cancel"}</button>
          <button className="btn-primary" onClick={onConfirm}><ClipboardPaste size={13} /> {zh ? "仍然粘贴" : "Paste anyway"}</button>
        </div>
      </div>
    </ModalShell>
  );
}

