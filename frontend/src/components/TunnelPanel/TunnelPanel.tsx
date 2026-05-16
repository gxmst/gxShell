import { useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowRightLeft, Circle, Plus, RefreshCw, Trash2 } from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import { AddTunnelRule, ListTunnelStatus, RemoveTunnelRule, RestartTunnels } from "../../../wailsjs/go/main/App";
import type { Tab, Toast } from "../../types";
import { t, type LangKey } from "../../i18n";

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

  const refresh = async () => {
    if (!active) return;
    setLoading(true);
    try {
      const list = await ListTunnelStatus(active.id);
      setTunnels(list || []);
    } catch (err) {
      onNotify(String(err), "error");
    }
    setLoading(false);
  };

  useEffect(() => {
    if (active) refresh();
  }, [active]);

  const restart = async () => {
    if (!active) return;
    try {
      const list = await RestartTunnels(active.id);
      setTunnels(list || []);
      onNotify(t(lang, "tunnelsRestarted"), "success");
    } catch (err) {
      onNotify(String(err), "error");
    }
  };

  const addTunnel = async (type: string, local: string, remote: string, bindHost?: string) => {
    if (!active) return;
    try {
      const rule = types.TunnelRule.createFrom({ id: crypto.randomUUID(), type, local, remote, bindHost: bindHost || "" });
      const status = await AddTunnelRule(active.id, rule);
      if (status.error) {
        onNotify(status.error, "error");
      } else {
        onNotify(t(lang, "tunnelAdded"), "success");
      }
      refresh();
      setAdding(false);
    } catch (err) {
      onNotify(String(err), "error");
    }
  };

  const removeTunnel = async (ruleID: string) => {
    if (!active) return;
    try {
      await RemoveTunnelRule(active.id, ruleID);
      refresh();
    } catch (err) {
      onNotify(String(err), "error");
    }
  };

  if (!active) return <div className="empty compact">{t(lang, "openTerminal")}</div>;

  const typeLabel = (tp: string) => {
    switch (tp) {
      case "local": return "L";
      case "remote": return "R";
      case "dynamic": return "D";
      default: return "?";
    }
  };

  return (
    <div className="tunnel-panel space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold text-muted">{t(lang, "tunnelRules")}</span>
        <div className="flex gap-1">
          <button className="tunnel-icon-btn" onClick={refresh} title={t(lang, "refresh")}><RefreshCw size={11} className={clsx(loading && "animate-spin")} /></button>
          <button className="tunnel-icon-btn" onClick={restart} title={t(lang, "restartTunnels")}><ArrowRightLeft size={11} /></button>
          <button className="tunnel-icon-btn" onClick={() => setAdding(!adding)} title={t(lang, "addTunnel")}><Plus size={11} /></button>
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

      {tunnels.length === 0 && !adding && (
        <div className="tunnel-empty">
          <ArrowRightLeft size={20} className="text-muted" />
          <span className="text-[10px] text-muted">{t(lang, "noTunnels")}</span>
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
          <button className="tunnel-icon-btn ml-0.5" onClick={() => tunnel.rule?.id && removeTunnel(tunnel.rule.id)} title={t(lang, "removeTunnel")}><Trash2 size={9} /></button>
        </div>
      ))}
    </div>
  );
}
