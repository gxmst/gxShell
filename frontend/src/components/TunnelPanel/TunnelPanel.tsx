import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowRightLeft, Circle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { AddTunnelRule, ListTunnelStatus, RemoveTunnelRule, RestartTunnels } from "../../../wailsjs/go/app/App";
import type { Tab, Toast } from "../../types";
import { t, type LangKey } from "../../i18n";
import { isRemoteSession } from "../../utils/sessionIdentity";

const ARM_TIMEOUT_MS = 3000;

const PRESETS: { label: LangKey; type: string; local: string; remote: string }[] = [
  { label: "presetWeb", type: "local", local: "127.0.0.1:8080", remote: "127.0.0.1:80" },
  { label: "presetMySQL", type: "local", local: "127.0.0.1:3306", remote: "127.0.0.1:3306" },
  { label: "presetRedis", type: "local", local: "127.0.0.1:6379", remote: "127.0.0.1:6379" },
  { label: "presetSOCKS", type: "dynamic", local: "127.0.0.1:1080", remote: "" },
];

export function TunnelPanel({ active, locale, onNotify }: { active?: Tab; locale?: string; onNotify: (text: string, tone?: Toast["tone"]) => void }) {
  const lang = locale || "en";
  const [tunnels, setTunnels] = useState<types.TunnelStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ type: "local", local: "127.0.0.1:8080", remote: "127.0.0.1:80", bindHost: "" });
  const [armedRemove, setArmedRemove] = useState("");
  const armedRemoveTimerRef = useRef<number | null>(null);
  // Forwarding rules live on one host, and every call below writes the reply
  // into this panel's state. The panel can be pointed at another host while a
  // call is in flight, so each one re-checks before touching that state.
  const activeSessionRef = useRef(active?.id || "");
  const refreshSeqRef = useRef(0);
  activeSessionRef.current = active?.id || "";

  const sessionId = isRemoteSession(active) ? active.id : "";

  useEffect(() => () => {
    if (armedRemoveTimerRef.current !== null) window.clearTimeout(armedRemoveTimerRef.current);
  }, []);

  const refresh = useCallback(async () => {
    const sessionID = sessionId;
    if (!sessionID) return;
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    try {
      const list = await ListTunnelStatus(sessionID);
      if (seq !== refreshSeqRef.current || activeSessionRef.current !== sessionID) return;
      setTunnels(list || []);
    } catch (err) {
      if (seq !== refreshSeqRef.current || activeSessionRef.current !== sessionID) return;
      onNotify(String(err), "error");
    } finally {
      if (seq === refreshSeqRef.current && activeSessionRef.current === sessionID) setLoading(false);
    }
  }, [sessionId, onNotify]);

  useEffect(() => {
    setTunnels([]);
    setAdding(false);
    setArmedRemove("");
    void refresh();
  }, [refresh]);

  const restart = async () => {
    const sessionID = sessionId;
    if (!sessionID) return;
    try {
      const list = await RestartTunnels(sessionID);
      if (activeSessionRef.current !== sessionID) return;
      setTunnels(list || []);
      onNotify(t(lang, "tunnelsRestarted"), "success");
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      onNotify(String(err), "error");
    }
  };

  const addTunnel = async (type: string, local: string, remote: string, bindHost?: string) => {
    const sessionID = sessionId;
    if (!sessionID) return;
    try {
      const rule = types.TunnelRule.createFrom({ id: crypto.randomUUID(), type, local, remote, bindHost: bindHost || "" });
      const status = await AddTunnelRule(sessionID, rule);
      if (activeSessionRef.current !== sessionID) return;
      if (status.error) {
        onNotify(status.error, "error");
      } else {
        onNotify(t(lang, "tunnelAdded"), "success");
      }
      void refresh();
      setAdding(false);
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      onNotify(String(err), "error");
    }
  };

  const removeTunnel = async (ruleID: string) => {
    const sessionID = sessionId;
    if (!sessionID) return;
    // Deleting a rule drops a forward that may be in active use, and the button
    // sits beside the status dot, so it arms first and deletes on the second
    // click within three seconds.
    if (armedRemove !== ruleID) {
      if (armedRemoveTimerRef.current !== null) window.clearTimeout(armedRemoveTimerRef.current);
      setArmedRemove(ruleID);
      armedRemoveTimerRef.current = window.setTimeout(() => {
        armedRemoveTimerRef.current = null;
        setArmedRemove("");
      }, ARM_TIMEOUT_MS);
      return;
    }
    if (armedRemoveTimerRef.current !== null) {
      window.clearTimeout(armedRemoveTimerRef.current);
      armedRemoveTimerRef.current = null;
    }
    setArmedRemove("");
    try {
      await RemoveTunnelRule(sessionID, ruleID);
      if (activeSessionRef.current !== sessionID) return;
      void refresh();
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      onNotify(String(err), "error");
    }
  };

  if (!sessionId) return <div className="empty compact">{t(lang, "openTerminal")}</div>;

  const typeLabel = (tp: string) => {
    switch (tp) {
      case "local": return "L";
      case "remote": return "R";
      case "dynamic": return "D";
      default: return "?";
    }
  };

  return (
    <div className="tunnel-panel panel-page">
      <div className="panel-page-header">
        <div className="panel-page-heading"><span className="panel-page-icon"><ArrowRightLeft size={14} /></span><span><strong>{t(lang, "tunnelRules")}</strong><small>{t(lang, "forwardingRuleCount", { count: String(tunnels.length) })}</small></span></div>
        <div className="panel-page-actions">
          <button className="panel-page-action" onClick={refresh} title={t(lang, "refresh")}><RefreshCw size={11} className={clsx(loading && "animate-spin")} /></button>
          <button className="panel-page-action" onClick={restart} title={t(lang, "restartTunnels")}><ArrowRightLeft size={11} /></button>
          <button className="panel-page-action panel-page-action-primary" onClick={() => setAdding(!adding)} title={t(lang, "addTunnel")}><Plus size={11} /></button>
        </div>
      </div>

      {adding && (
        <div className="tunnel-add-form space-y-1">
          <div className="flex gap-1">
            <select className="input text-[10px] flex-1" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              <option value="local">{t(lang, "tunnelLocal")}</option>
              <option value="remote">{t(lang, "tunnelRemote")}</option>
              <option value="dynamic">{t(lang, "tunnelDynamic")}</option>
            </select>
          </div>
          <div className="flex gap-1 items-center">
            <input className="input text-[10px] font-mono flex-1" value={form.local} placeholder="127.0.0.1:8080" onChange={(e) => setForm({ ...form, local: e.target.value })} />
            {form.type !== "dynamic" && (
              <>
                <span className="text-[9px] text-muted">→</span>
                <input className="input text-[10px] font-mono flex-1" value={form.remote} placeholder="127.0.0.1:80" onChange={(e) => setForm({ ...form, remote: e.target.value })} />
              </>
            )}
          </div>
          <button className="btn-primary w-full text-[10px] py-1" onClick={() => addTunnel(form.type, form.local, form.remote, form.bindHost)}>{t(lang, "addTunnel")}</button>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p, i) => (
              <button key={i} className="tunnel-preset-btn" onClick={() => addTunnel(p.type, p.local, p.remote)}>{t(lang, p.label)}</button>
            ))}
          </div>
        </div>
      )}

      <div className="panel-list">
      {tunnels.length === 0 && !adding && (
        <div className="panel-empty tunnel-empty">
          <ArrowRightLeft size={20} />
          <span>{t(lang, "noTunnels")}</span>
        </div>
      )}
      {tunnels.map((tunnel, i) => (
        <div key={tunnel.rule?.id || i} className={clsx("tunnel-row", !tunnel.active && "tunnel-row-inactive")}>
          <div className="tunnel-type-badge">{typeLabel(tunnel.rule?.type || "")}</div>
          <div className="tunnel-info">
            <div className="tunnel-addr">
              <span className="text-[10px] font-mono">{tunnel.rule?.local || "?"}</span>
              {tunnel.rule?.type !== "dynamic" && (
                <>
                  <span className="text-[9px] text-muted">→</span>
                  <span className="text-[10px] font-mono">{tunnel.rule?.remote || "?"}</span>
                </>
              )}
            </div>
            {tunnel.error && <div className="text-[9px] text-bad truncate">{tunnel.error}</div>}
          </div>
          <Circle size={8} className={clsx("shrink-0", tunnel.active ? "fill-ok text-ok" : "fill-muted text-muted")} />
          <button
            className={clsx("tunnel-icon-btn", "ml-0.5", armedRemove === tunnel.rule?.id && "action-armed")}
            onClick={() => tunnel.rule?.id && void removeTunnel(tunnel.rule.id)}
            title={armedRemove === tunnel.rule?.id ? t(lang, "confirm") : t(lang, "removeTunnel")}
          ><Trash2 size={9} /></button>
        </div>
      ))}</div>
    </div>
  );
}
