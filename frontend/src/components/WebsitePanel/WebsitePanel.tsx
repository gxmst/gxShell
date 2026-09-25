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
import { isRemoteSession } from "../../utils/sessionIdentity";
import { useDiscardGuard, useProfileDraft } from "../../hooks/useProfileDraft";
import { UnsavedChangesDialog } from "../modals/UnsavedChangesDialog";

const ARM_TIMEOUT_MS = 3000;

type SiteDraft = {
  backend: string;
  mode: string;
  name: string;
  isNew: boolean;
  config: string;
  /** Config as loaded or saved, so an untouched draft does not read as dirty. */
  baseline: string;
};

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
  const activeSessionRef = useRef(props.active?.id || "");
  const refreshSeqRef = useRef(0);
  const armedTimerRef = useRef<number | null>(null);
  activeSessionRef.current = props.active?.id || "";

  // A site config is read from and written to one host. A local terminal or a
  // Markdown document has a tab id too, and acting on one only produced a
  // "session not found" error.
  const sessionId = isRemoteSession(props.active) ? props.active.id : "";

  // The draft belongs to the host, so a second terminal on the same server - or
  // an auto-reconnect that hands the session a new id - no longer discards it.
  const [draft, setDraft] = useProfileDraft<SiteDraft | null>(
    "websites",
    props.active?.profileId || "",
    null,
  );
  const dirty = draft !== null && draft.config !== draft.baseline;
  const { pending, guard, dismiss } = useDiscardGuard(dirty);

  const refresh = useCallback(async () => {
    const sessionID = sessionId;
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
  }, [sessionId, props.onNotify]);

  useEffect(() => {
    refresh();
    return () => {
      if (armedTimerRef.current !== null) window.clearTimeout(armedTimerRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    setStatus(null);
    setArmed(null);
  }, [props.active?.id]);

  const openNew = () => guard(() => {
    const spec = status?.backends?.[0] || "nginx:sites";
    const [backend, mode] = spec.split(":");
    const config = defaultConfig(backend);
    setDraft({
      backend,
      mode,
      name: backend === "apache" ? "example.conf" : "example.com",
      isNew: true,
      config,
      baseline: config,
    });
  });

  const changeNewBackend = (spec: string) => {
    const [backend, mode] = spec.split(":");
    const config = defaultConfig(backend);
    setDraft((prev) => prev && {
      ...prev,
      backend,
      mode,
      name: backend === "apache" || mode === "confd" ? "example.conf" : "example.com",
      config,
      baseline: config,
    });
  };

  const loadSite = async (site: types.WebsiteInfo) => {
    const sessionID = sessionId;
    if (!sessionID) return;
    const key = `${site.backend}:${site.mode}:${site.name}`;
    setBusy(key);
    try {
      const text = await GetWebsiteConfig(sessionID, site.backend, site.mode, site.name);
      // The read is a round trip: the panel can be pointed at another host
      // before it returns, and this config belongs to the host it came from.
      if (activeSessionRef.current !== sessionID) return;
      setDraft({
        backend: site.backend,
        mode: site.mode,
        name: site.name,
        isNew: false,
        config: text || "",
        baseline: text || "",
      });
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      props.onNotify(String(err), "error");
    } finally {
      if (activeSessionRef.current === sessionID) setBusy(null);
    }
  };

  const openEdit = (site: types.WebsiteInfo) => guard(() => { void loadSite(site); });

  // notifyOnError is false when the discard prompt is asking: it shows the
  // failure inline, and a toast on top of that would say it twice.
  const persist = async (notifyOnError: boolean): Promise<boolean> => {
    const sessionID = sessionId;
    if (!sessionID || !draft) return false;
    setBusy("editor");
    try {
      await SaveWebsiteConfig(sessionID, draft.backend, draft.mode, draft.name, draft.config);
      return activeSessionRef.current === sessionID;
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return false;
      if (notifyOnError) props.onNotify(String(err), "error");
      return false;
    } finally {
      if (activeSessionRef.current === sessionID) setBusy(null);
    }
  };

  const save = async (): Promise<boolean> => {
    const ok = await persist(true);
    if (!ok) return false;
    props.onNotify(t(lang, "siteSaved"), "success");
    setDraft(null);
    await refresh();
    return true;
  };

  const saveFromPrompt = async (): Promise<boolean> => {
    const ok = await persist(false);
    if (!ok) return false;
    setDraft(null);
    await refresh();
    return true;
  };

  const closeEditor = () => guard(() => setDraft(null));

  const toggle = async (site: types.WebsiteInfo) => {
    const sessionID = sessionId;
    if (!sessionID) return;
    const key = `${site.backend}:${site.mode}:${site.name}`;
    setBusy(key);
    try {
      await SetWebsiteEnabled(sessionID, site.backend, site.mode, site.name, !site.enabled);
      if (activeSessionRef.current !== sessionID) return;
      props.onNotify(t(lang, site.enabled ? "siteDisabled" : "siteEnabled"), "success");
      await refresh();
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      props.onNotify(String(err), "error");
    } finally {
      if (activeSessionRef.current === sessionID) setBusy(null);
    }
  };

  const remove = async (site: types.WebsiteInfo) => {
    const sessionID = sessionId;
    if (!sessionID) return;
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
      await DeleteWebsite(sessionID, site.backend, site.mode, site.name);
      if (activeSessionRef.current !== sessionID) return;
      props.onNotify(t(lang, "siteDeleted"), "success");
      await refresh();
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      props.onNotify(String(err), "error");
    } finally {
      if (activeSessionRef.current === sessionID) setBusy(null);
    }
  };

  const testConfig = async () => {
    const sessionID = sessionId;
    if (!sessionID) return;
    const backend = draft?.backend || status?.sites?.[0]?.backend || status?.backends?.[0]?.split(":")[0];
    if (!backend) return;
    setBusy("test");
    try {
      const output = await TestWebsiteConfig(sessionID, backend);
      if (activeSessionRef.current !== sessionID) return;
      props.onNotify((output || t(lang, "siteTestOk")).trim().slice(0, 220), "success");
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      props.onNotify(String(err), "error");
    } finally {
      if (activeSessionRef.current === sessionID) setBusy(null);
    }
  };

  if (!sessionId) {
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

      {draft && (
        <div className="admin-editor site-editor">
          <div className="admin-editor-title"><span>{draft.isNew ? t(lang, "siteAdd") : t(lang, "siteEdit")}</span><button className="mini-btn" onClick={closeEditor} title={t(lang, "close")}><X size={10} /></button></div>
          <div className="site-editor-grid">
            <label className="field-label"><span className="field-label-text">{t(lang, "siteBackend")}</span><select className="input text-[10px]" value={`${draft.backend}:${draft.mode}`} disabled={!draft.isNew} onChange={(e) => changeNewBackend(e.target.value)}>{backends.map((spec) => <option key={spec} value={spec}>{spec.replace(":", " · ")}</option>)}</select></label>
            <label className="field-label"><span className="field-label-text">{t(lang, "name")}</span><input className="input font-mono text-[10px]" value={draft.name} disabled={!draft.isNew} onChange={(e) => { const name = e.target.value; setDraft((prev) => prev && { ...prev, name }); }} /></label>
          </div>
          <label className="field-label"><span className="field-label-text">{t(lang, "siteConfig")}</span><textarea className="input site-config-input font-mono text-[10px]" spellCheck={false} value={draft.config} onChange={(e) => { const config = e.target.value; setDraft((prev) => prev && { ...prev, config }); }} /></label>
          <div className="admin-editor-footer"><button className="btn-secondary text-[10px]" onClick={testConfig}><CheckCircle2 size={11} /> {t(lang, "siteTestCurrent")}</button><button className="btn-primary text-[10px]" onClick={() => { void save(); }} disabled={busy === "editor"}><Save size={11} /> {t(lang, "save")}</button></div>
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

      {pending && (
        <UnsavedChangesDialog
          locale={lang}
          title={draft?.name || t(lang, "siteEdit")}
          body={t(lang, "unsavedSiteDraft")}
          onCancel={dismiss}
          onDiscard={() => { const next = pending; dismiss(); next(); }}
          onSave={async () => {
            const ok = await saveFromPrompt();
            if (ok) { const next = pending; dismiss(); next(); }
            return ok;
          }}
        />
      )}
    </div>
  );
}
