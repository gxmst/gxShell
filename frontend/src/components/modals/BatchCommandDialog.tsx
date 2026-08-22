import { AlignLeft, List, Radio, Repeat2, Send, Square, Timer } from "lucide-react";
import { useState } from "react";
import type { BatchCommandOptions } from "../../utils/batchCommand";
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
  const zh = props.language === "zh-CN";
  const [mode, setMode] = useState<BatchCommandOptions["mode"]>("whole");
  const [intervalMs, setIntervalMs] = useState(300);
  const [repeat, setRepeat] = useState(1);
  const progress = props.total > 0 ? Math.min(100, (props.sent / props.total) * 100) : 0;

  return (
    <ModalShell onClose={() => props.running ? props.onStop() : props.onClose()} ariaLabel={zh ? "批量发送命令" : "Send command to multiple sessions"}>
      <div className="batch-command-dialog">
        <DialogHeader
          icon={<Radio size={15} />}
          title={zh ? "批量发送命令" : "Send command to multiple sessions"}
          description={`${props.request.commandName} · ${props.request.targets.length} ${zh ? "个会话" : props.request.targets.length === 1 ? "session" : "sessions"}`}
        />

        <pre className="batch-command-preview">{props.request.command}</pre>

        <div className="batch-command-targets" aria-label={zh ? "发送目标" : "Targets"}>
          {props.request.targets.map((target) => <span key={target.id} title={target.id}>{target.title}</span>)}
        </div>

        <div className="batch-command-options">
          <div className="batch-command-segmented" role="group" aria-label={zh ? "发送模式" : "Send mode"}>
            <button type="button" className={mode === "whole" ? "active" : ""} disabled={props.running} onClick={() => setMode("whole")}><AlignLeft size={12} /> {zh ? "整体" : "Whole"}</button>
            <button type="button" className={mode === "lines" ? "active" : ""} disabled={props.running} onClick={() => setMode("lines")}><List size={12} /> {zh ? "逐行" : "Lines"}</button>
          </div>
          <label><Timer size={12} /><span>{zh ? "间隔" : "Interval"}</span><input type="number" min={0} max={10000} step={100} disabled={props.running} value={intervalMs} onChange={(event) => setIntervalMs(Number(event.target.value))} /><small>ms</small></label>
          <label><Repeat2 size={12} /><span>{zh ? "重复" : "Repeat"}</span><input type="number" min={1} max={20} disabled={props.running} value={repeat} onChange={(event) => setRepeat(Number(event.target.value))} /></label>
        </div>

        {props.running && (
          <div className="batch-command-progress" role="status">
            <div><span>{zh ? "已发送" : "Sent"}</span><strong>{props.sent}/{props.total}</strong></div>
            <div className="batch-command-progress-track"><span style={{ width: `${progress}%` }} /></div>
          </div>
        )}

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={props.running ? props.onStop : props.onClose}>{props.running ? <Square size={12} /> : null}{props.running ? (zh ? "停止" : "Stop") : (zh ? "取消" : "Cancel")}</button>
          <button className="btn-primary" disabled={props.running || props.request.targets.length === 0 || !props.request.command} onClick={() => props.onStart({ mode, intervalMs, repeat })}><Send size={13} /> {zh ? "确认发送" : "Send"}</button>
        </div>
      </div>
    </ModalShell>
  );
}
