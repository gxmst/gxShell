import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  CheckCircle2,
  Edit3,
  Globe2,
  Loader2,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Save,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import {
  DeleteWebsite,
  GetWebsiteConfig,
  GetWebsiteStatus,
  SaveWebsiteConfig,
  SetWebsiteEnabled,
  TestWebsiteConfig,
} from "../../../wailsjs/go/app/App";
import { t } from "../../i18n";
import type { Tab, Toast } from "../../types";

const ARM_TIMEOUT_MS = 3000;

function defaultConfig(backend: string) {
  if (backend === "apache") {
    return `<VirtualHost *:80>\n    ServerName example.com\n    DocumentRoot /var/www/html\n\n    <Directory /var/www/html>\n        Require all granted\n    </Directory>\n</VirtualHost>\n`;
  }
  return `server {\n    listen 80;\n    server_name example.com;\n    root /var/www/html;\n    index index.html index.htm;\n\n    location / {\n        try_files $uri $uri/ =404;\n    }\n}\n`;
}

export function WebsitePanel(props: {
  active?: Tab;
  locale: string;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
}) {
  const lang = props.locale;
  const [status, setStatus] = useState<types.WebsiteStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ backend: string; mode: string; name: string; isNew: boolean } | null>(null);
  const [config, setConfig] = useState("");
  const activeSessionRef = useRef(props.active?.id || "");
  const refreshSeqRef = useRef(0);
  const armedTimerRef = useRef<number | null>(null);
  activeSessionRef.current = props.active?.id || "";

  const refresh = useCallback(async () => {
    const sessionID = props.active?.id;
    if (!sessionID) return;
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    try {
      const next = await GetWebsiteStatus(sessionID);
      if (seq !== refreshSeqRef.current || activeSessionRef.current !== sessionID) return;
      setStatus(next || null);
    } catch (err) {
      if (seq !== refreshSeqRef.current || activeSessionRef.current !== sessionID) return;
      setStatus(null);
      props.onNotify(String(err), "error");
    } finally {
      if (seq === refreshSeqRef.current && activeSessionRef.current === sessionID) setLoading(false);
    }
  }, [props.active?.id, props.onNotify]);

  useEffect(() => {
    refresh();
    return () => {
      if (armedTimerRef.current !== null) window.clearTimeout(armedTimerRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    setStatus(null);
    setEditor(null);
    setArmed(null);
  }, [props.active?.id]);

  const openNew = () => {
    const spec = status?.backends?.[0] || "nginx:sites";
    const [backend, mode] = spec.split(":");
    setEditor({ backend, mode, name: backend === "apache" ? "example.conf" : "example.com", isNew: true });
    setConfig(defaultConfig(backend));
  };

  const changeNewBackend = (spec: string) => {
    const [backend, mode] = spec.split(":");
    setEditor({ backend, mode, name: backend === "apache" || mode === "confd" ? "example.conf" : "example.com", isNew: true });
    setConfig(defaultConfig(backend));
  };

  const openEdit = async (site: types.WebsiteInfo) => {
    if (!props.active?.id) return;
    const key = `${site.backend}:${site.mode}:${site.name}`;
    setBusy(key);
    try {
      const text = await GetWebsiteConfig(props.active.id, site.backend, site.mode, site.name);
      setEditor({ backend: site.backend, mode: site.mode, name: site.name, isNew: false });
      setConfig(text || "");
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!props.active?.id || !editor) return;
    setBusy("editor");
    try {
      await SaveWebsiteConfig(props.active.id, editor.backend, editor.mode, editor.name, config);
      props.onNotify(t(lang, "siteSaved"), "success");
      setEditor(null);
      await refresh();
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (site: types.WebsiteInfo) => {
    if (!props.active?.id) return;
    const key = `${site.backend}:${site.mode}:${site.name}`;
    setBusy(key);
    try {
      await SetWebsiteEnabled(props.active.id, site.backend, site.mode, site.name, !site.enabled);
      props.onNotify(t(lang, site.enabled ? "siteDisabled" : "siteEnabled"), "success");
      await refresh();
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (site: types.WebsiteInfo) => {
    if (!props.active?.id) return;
    const key = `${site.backend}:${site.mode}:${site.name}`;
    if (armed !== key) {
      setArmed(key);
      if (armedTimerRef.current !== null) window.clearTimeout(armedTimerRef.current);
      armedTimerRef.current = window.setTimeout(() => setArmed(null), ARM_TIMEOUT_MS);
      return;
    }
    setArmed(null);
    setBusy(key);
    try {
      await DeleteWebsite(props.active.id, site.backend, site.mode, site.name);
      props.onNotify(t(lang, "siteDeleted"), "success");
      await refresh();
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const testConfig = async () => {
    if (!props.active?.id) return;
    const backend = editor?.backend || status?.sites?.[0]?.backend || status?.backends?.[0]?.split(":")[0];
    if (!backend) return;
    setBusy("test");
    try {
      const output = await TestWebsiteConfig(props.active.id, backend);
      props.onNotify((output || t(lang, "siteTestOk")).trim().slice(0, 220), "success");
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  if (!props.active?.id) {
    return <div className="panel-page"><div className="panel-empty"><Globe2 size={24} /><span>{t(lang, "noActiveSession")}</span></div></div>;
  }

  const sites = status?.sites || [];
  const backends = status?.backends || [];
  // Site listing runs unprivileged, so on a non-root session the configs may be
  // unreadable. Saying so is the difference between "this host has no sites" and
  // "gxShell could not read them".
  const unreadable = status?.unreadable || 0;

  return (
    <div className="panel-page admin-panel">
      <div className="panel-page-header">
        <div className="panel-page-heading">
          <span className="panel-page-icon"><Globe2 size={14} /></span>
          <span><strong>{t(lang, "websites")}</strong><small>{t(lang, "siteCount", { n: String(sites.length) })}</small></span>
        </div>
        <div className="panel-page-actions">
          <button className="panel-page-action" onClick={testConfig} disabled={busy === "test" || backends.length === 0} title={t(lang, "siteTest")}><CheckCircle2 size={11} /></button>
          <button className="panel-page-action" onClick={refresh} disabled={loading} title={t(lang, "refresh")}><RefreshCw size={11} className={loading ? "animate-spin" : ""} /></button>
          <button className="panel-page-action" onClick={openNew} disabled={backends.length === 0} title={t(lang, "siteAdd")}><Plus size={11} /></button>
        </div>
      </div>

      {editor && (
        <div className="admin-editor site-editor">
          <div className="admin-editor-title"><span>{editor.isNew ? t(lang, "siteAdd") : t(lang, "siteEdit")}</span><button className="mini-btn" onClick={() => setEditor(null)}><X size={10} /></button></div>
          <div className="site-editor-grid">
            <label className="field-label"><span className="field-label-text">{t(lang, "siteBackend")}</span><select className="input text-[10px]" value={`${editor.backend}:${editor.mode}`} disabled={!editor.isNew} onChange={(e) => changeNewBackend(e.target.value)}>{backends.map((spec) => <option key={spec} value={spec}>{spec.replace(":", " · ")}</option>)}</select></label>
            <label className="field-label"><span className="field-label-text">{t(lang, "name")}</span><input className="input font-mono text-[10px]" value={editor.name} disabled={!editor.isNew} onChange={(e) => setEditor({ ...editor, name: e.target.value })} /></label>
          </div>
          <label className="field-label"><span className="field-label-text">{t(lang, "siteConfig")}</span><textarea className="input site-config-input font-mono text-[10px]" spellCheck={false} value={config} onChange={(e) => setConfig(e.target.value)} /></label>
          <div className="admin-editor-footer"><button className="btn-secondary text-[10px]" onClick={testConfig}><CheckCircle2 size={11} /> {t(lang, "siteTestCurrent")}</button><button className="btn-primary text-[10px]" onClick={save} disabled={busy === "editor"}><Save size={11} /> {t(lang, "save")}</button></div>
        </div>
      )}

      <div className="panel-list">
        {!loading && backends.length === 0 && <div className="panel-empty"><Server size={20} /><span>{t(lang, "siteNoBackend")}</span></div>}
        {!loading && backends.length > 0 && sites.length === 0 && (
          <div className="panel-empty">
            <Globe2 size={20} />
            <span>{unreadable > 0 ? t(lang, "siteAllUnreadable", { n: String(unreadable) }) : t(lang, "siteEmpty")}</span>
          </div>
        )}
        {!loading && unreadable > 0 && sites.length > 0 && (
          <div className="panel-note"><AlertTriangle size={11} /><span>{t(lang, "siteSomeUnreadable", { n: String(unreadable) })}</span></div>
        )}
        {sites.map((site) => {
          const key = `${site.backend}:${site.mode}:${site.name}`;
          const isBusy = busy === key;
          const host = site.serverNames?.join(", ") || site.name;
          return (
            <div className={clsx("panel-item admin-item", !site.enabled && "admin-item-disabled")} key={key}>
              <span className={clsx("panel-item-icon admin-state-icon", site.enabled && "admin-state-on")}>{site.enabled ? <Globe2 size={12} /> : <PowerOff size={12} />}</span>
              <div className="panel-item-copy">
                <div className="panel-item-title" title={host}>{host}</div>
                <div className="panel-item-meta" title={site.root || site.name}>{site.backend} · {site.listen?.join(", ") || "—"}{site.root ? ` · ${site.root}` : ""}</div>
              </div>
              <div className="panel-item-actions">
                <button className={clsx("container-action-btn", site.enabled ? "text-warn" : "text-ok")} onClick={() => toggle(site)} disabled={isBusy} title={t(lang, site.enabled ? "siteDisable" : "siteEnable")}>{isBusy ? <Loader2 size={11} className="animate-spin" /> : site.enabled ? <PowerOff size={11} /> : <Power size={11} />}</button>
                <button className="container-action-btn" onClick={() => openEdit(site)} disabled={isBusy} title={t(lang, "siteEdit")}><Edit3 size={11} /></button>
                <button className={clsx("container-action-btn text-bad", armed === key && "action-armed")} onClick={() => remove(site)} disabled={isBusy} title={armed === key ? t(lang, "confirm") : t(lang, "delete")}>{armed === key ? <AlertTriangle size={11} /> : <Trash2 size={11} />}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
