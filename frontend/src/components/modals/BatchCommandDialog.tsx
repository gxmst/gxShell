import { AlignLeft, List, Radio, Repeat2, Send, Square, Timer } from "lucide-react";
import { useState } from "react";
import type { BatchCommandOptions } from "../../utils/batchCommand";
import { t } from "../../i18n";
import { DialogHeader, ModalShell } from "./ModalShell";

export type BatchCommandRequest = {
  commandName: string;
  command: string;
  targets: Array<{ id: string; title: string }>;
};

export function BatchCommandDialog(props: {
  request: BatchCommandRequest;
  language: string;
  running: boolean;
  sent: number;
  total: number;
  onClose: () => void;
  onStart: (options: BatchCommandOptions) => void;
  onStop: () => void;
}) {
  const lang = props.language;
  const [mode, setMode] = useState<BatchCommandOptions["mode"]>("whole");
  const [intervalMs, setIntervalMs] = useState(300);
  const [repeat, setRepeat] = useState(1);
  const progress = props.total > 0 ? Math.min(100, (props.sent / props.total) * 100) : 0;

  return (
    <ModalShell onClose={() => props.running ? props.onStop() : props.onClose()} ariaLabel={t(lang, "batchCommandTitle")}>
      <div className="batch-command-dialog">
        <DialogHeader
          icon={<Radio size={15} />}
          title={t(lang, "batchCommandTitle")}
          description={`${props.request.commandName} · ${t(lang, props.request.targets.length === 1 ? "sessionCountOne" : "sessionCountMany", { count: String(props.request.targets.length) })}`}
        />

        <pre className="batch-command-preview">{props.request.command}</pre>

        <div className="batch-command-targets" aria-label={t(lang, "batchCommandTargets")}>
          {props.request.targets.map((target) => <span key={target.id} title={target.id}>{target.title}</span>)}
        </div>

        <div className="batch-command-options">
          <div className="batch-command-segmented" role="group" aria-label={t(lang, "batchCommandSendMode")}>
            <button type="button" className={mode === "whole" ? "active" : ""} disabled={props.running} onClick={() => setMode("whole")}><AlignLeft size={12} /> {t(lang, "batchCommandWhole")}</button>
            <button type="button" className={mode === "lines" ? "active" : ""} disabled={props.running} onClick={() => setMode("lines")}><List size={12} /> {t(lang, "batchCommandLines")}</button>
          </div>
          <label><Timer size={12} /><span>{t(lang, "batchCommandInterval")}</span><input type="number" min={0} max={10000} step={100} disabled={props.running} value={intervalMs} onChange={(event) => setIntervalMs(Number(event.target.value))} /><small>ms</small></label>
          <label><Repeat2 size={12} /><span>{t(lang, "batchCommandRepeat")}</span><input type="number" min={1} max={20} disabled={props.running} value={repeat} onChange={(event) => setRepeat(Number(event.target.value))} /></label>
        </div>

        {props.running && (
          <div className="batch-command-progress" role="status">
            <div><span>{t(lang, "batchCommandSent")}</span><strong>{props.sent}/{props.total}</strong></div>
            <div className="batch-command-progress-track"><span style={{ width: `${progress}%` }} /></div>
          </div>
        )}

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={props.running ? props.onStop : props.onClose}>{props.running ? <Square size={12} /> : null}{props.running ? t(lang, "stop") : t(lang, "cancel")}</button>
          <button className="btn-primary" disabled={props.running || props.request.targets.length === 0 || !props.request.command} onClick={() => props.onStart({ mode, intervalMs, repeat })}><Send size={13} /> {t(lang, "batchCommandConfirm")}</button>
        </div>
      </div>
    </ModalShell>
  );
}
