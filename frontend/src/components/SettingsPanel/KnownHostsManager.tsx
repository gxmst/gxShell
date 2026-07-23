import { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { ListKnownHosts, RemoveKnownHost } from "../../../wailsjs/go/main/App";
import { sshmanager } from "../../../wailsjs/go/models";
import { t } from "../../i18n";

// KnownHostsManager lists the trusted SSH host keys and lets the user forget
// one. Forgetting an entry means the next connection to that host goes through
// trust-on-first-use again. It reads live from the backend known_hosts file,
// not settings.json, so it refreshes on mount and after every removal.
export function KnownHostsManager({ language, onNotify }: { language: string; onNotify?: (text: string, tone?: "info" | "error" | "success") => void }) {
  const lang = language;
  const [entries, setEntries] = useState<sshmanager.KnownHostEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");

  const load = () => {
    setLoading(true);
    ListKnownHosts()
      .then((list) => setEntries(list || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const remove = async (entry: sshmanager.KnownHostEntry) => {
    const key = `${entry.hosts}|${entry.fingerprint}`;
    setBusy(key);
    try {
      await RemoveKnownHost(entry.hosts, entry.fingerprint);
      setEntries((prev) => prev.filter((e) => !(e.hosts === entry.hosts && e.fingerprint === entry.fingerprint)));
      onNotify?.(t(lang, "knownHostRemoved"), "success");
    } catch (err) {
      onNotify?.(String(err), "error");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="panel dense space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold"><ShieldCheck size={13} /> {t(lang, "knownHosts")}</span>
        <button className="icon-btn compact-icon" onClick={load} title={t(lang, "refresh")}><RefreshCw size={12} /></button>
      </div>
      <div className="text-[10px] text-muted leading-snug">{t(lang, "knownHostsHint")}</div>
      {loading && <div className="text-[10px] text-muted">{t(lang, "loading")}</div>}
      {!loading && entries.length === 0 && <div className="text-[10px] text-muted">{t(lang, "noKnownHosts")}</div>}
      {entries.map((entry) => {
        const key = `${entry.hosts}|${entry.fingerprint}`;
        return (
          <div key={key} className="flex items-center gap-2 rounded px-2 py-1" style={{ backgroundColor: "var(--panel-raised)" }}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-mono">{entry.hosts}</div>
              <div className="truncate text-[9px] text-muted font-mono">{entry.keyType} · {entry.fingerprint}</div>
            </div>
            <button className="icon-btn compact-icon text-bad" disabled={busy === key} onClick={() => remove(entry)} title={t(lang, "forgetHost")}><Trash2 size={11} /></button>
          </div>
        );
      })}
    </div>
  );
}
