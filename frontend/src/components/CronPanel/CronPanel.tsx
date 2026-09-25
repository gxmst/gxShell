import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  CalendarClock,
  Edit3,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import {
  DeleteCronJob,
  ListCronJobs,
  RunCronJob,
  SaveCronJob,
  SetCronJobEnabled,
} from "../../../wailsjs/go/app/App";
import { t } from "../../i18n";
import type { Tab, Toast } from "../../types";
import { isRemoteSession } from "../../utils/sessionIdentity";
import { useDiscardGuard, useProfileDraft } from "../../hooks/useProfileDraft";
import { UnsavedChangesDialog } from "../modals/UnsavedChangesDialog";

const ARM_TIMEOUT_MS = 3000;
const NEW_SCHEDULE = "0 3 * * *";

type CronDraft = {
  /** Job id being edited, or "" for a new job. */
  editing: string;
  schedule: string;
  command: string;
  enabled: boolean;
  /** Form as loaded, so an untouched draft does not read as dirty. */
  baseline: { schedule: string; command: string; enabled: boolean };
};

export function CronPanel(props: {
  active?: Tab;
  locale: string;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
}) {
  const lang = props.locale;
  const [jobs, setJobs] = useState<types.CronJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [armed, setArmed] = useState<string | null>(null);
  const activeSessionRef = useRef(props.active?.id || "");
  const refreshSeqRef = useRef(0);
  const armedTimerRef = useRef<number | null>(null);
  activeSessionRef.current = props.active?.id || "";

  // A crontab belongs to one host. A local terminal or a Markdown document has
  // a tab id too, and acting on one only produced a "session not found" error.
  const sessionId = isRemoteSession(props.active) ? props.active.id : "";

  // The draft belongs to the host, so a second terminal on the same server - or
  // an auto-reconnect that hands the session a new id - no longer discards it.
  const [draft, setDraft] = useProfileDraft<CronDraft | null>(
    "cron",
    props.active?.profileId || "",
    null,
  );
  const dirty = draft !== null && (
    draft.schedule !== draft.baseline.schedule
    || draft.command !== draft.baseline.command
    || draft.enabled !== draft.baseline.enabled
  );
  const { pending, guard, dismiss } = useDiscardGuard(dirty);

  const refresh = useCallback(async () => {
    const sessionID = sessionId;
    if (!sessionID) return;
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    try {
      const next = await ListCronJobs(sessionID);
      if (seq !== refreshSeqRef.current || activeSessionRef.current !== sessionID) return;
      setJobs(next || []);
    } catch (err) {
      if (seq !== refreshSeqRef.current || activeSessionRef.current !== sessionID) return;
      setJobs([]);
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
    setJobs([]);
    setArmed(null);
  }, [props.active?.id]);

  const openNew = () => guard(() => {
    const baseline = { schedule: NEW_SCHEDULE, command: "", enabled: true };
    setDraft({ editing: "", ...baseline, baseline });
  });

  const openEdit = (job: types.CronJob) => guard(() => {
    const baseline = { schedule: job.schedule, command: job.command, enabled: job.enabled };
    setDraft({ editing: job.id, ...baseline, baseline });
  });

  const closeEditor = () => guard(() => setDraft(null));

  // notifyOnError is false when the discard prompt is asking: it shows the
  // failure inline, and a toast on top of that would say it twice.
  const persist = async (notifyOnError: boolean): Promise<boolean> => {
    const sessionID = sessionId;
    if (!sessionID || !draft) return false;
    setBusy(draft.editing || "new");
    try {
      await SaveCronJob(sessionID, draft.editing, draft.schedule, draft.command, draft.enabled);
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
    props.onNotify(t(lang, "cronSaved"), "success");
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

  const toggle = async (job: types.CronJob) => {
    const sessionID = sessionId;
    if (!sessionID) return;
    setBusy(job.id);
    try {
      await SetCronJobEnabled(sessionID, job.id, !job.enabled);
      if (activeSessionRef.current !== sessionID) return;
      await refresh();
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      props.onNotify(String(err), "error");
    } finally {
      if (activeSessionRef.current === sessionID) setBusy(null);
    }
  };

  const run = async (job: types.CronJob) => {
    const sessionID = sessionId;
    if (!sessionID) return;
    setBusy(job.id);
    try {
      const output = await RunCronJob(sessionID, job.id);
      if (activeSessionRef.current !== sessionID) return;
      const summary = (output || "").trim().slice(0, 180);
      props.onNotify(summary ? `${t(lang, "cronRunOk")}: ${summary}` : t(lang, "cronRunOk"), "success");
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      props.onNotify(String(err), "error");
    } finally {
      if (activeSessionRef.current === sessionID) setBusy(null);
    }
  };

  const remove = async (job: types.CronJob) => {
    const sessionID = sessionId;
    if (!sessionID) return;
    if (armed !== job.id) {
      setArmed(job.id);
      if (armedTimerRef.current !== null) window.clearTimeout(armedTimerRef.current);
      armedTimerRef.current = window.setTimeout(() => setArmed(null), ARM_TIMEOUT_MS);
      return;
    }
    setArmed(null);
    setBusy(job.id);
    try {
      await DeleteCronJob(sessionID, job.id);
      if (activeSessionRef.current !== sessionID) return;
      props.onNotify(t(lang, "cronDeleted"), "success");
      await refresh();
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      props.onNotify(String(err), "error");
    } finally {
      if (activeSessionRef.current === sessionID) setBusy(null);
    }
  };

  if (!sessionId) {
    return <div className="panel-page"><div className="panel-empty"><CalendarClock size={24} /><span>{t(lang, "noActiveSession")}</span></div></div>;
  }

  return (
    <div className="panel-page admin-panel">
      <div className="panel-page-header">
        <div className="panel-page-heading">
          <span className="panel-page-icon"><CalendarClock size={14} /></span>
          <span><strong>{t(lang, "cronJobs")}</strong><small>{t(lang, "cronCount", { n: String(jobs.length) })}</small></span>
        </div>
        <div className="panel-page-actions">
          <button className="panel-page-action" onClick={refresh} disabled={loading} title={t(lang, "refresh")}><RefreshCw size={11} className={loading ? "animate-spin" : ""} /></button>
          <button className="panel-page-action" onClick={openNew} title={t(lang, "cronAdd")}><Plus size={11} /></button>
        </div>
      </div>

      {draft && (
        <div className="admin-editor cron-editor">
          <div className="admin-editor-title"><span>{draft.editing ? t(lang, "cronEdit") : t(lang, "cronAdd")}</span><button className="mini-btn" onClick={closeEditor} title={t(lang, "close")}><X size={10} /></button></div>
          <label className="field-label"><span className="field-label-text">{t(lang, "cronSchedule")}</span><input className="input font-mono text-[10px]" value={draft.schedule} onChange={(e) => { const schedule = e.target.value; setDraft((prev) => prev && { ...prev, schedule }); }} placeholder="0 3 * * *" /></label>
          <label className="field-label"><span className="field-label-text">{t(lang, "command")}</span><textarea className="input admin-command-input font-mono text-[10px]" value={draft.command} onChange={(e) => { const command = e.target.value; setDraft((prev) => prev && { ...prev, command }); }} placeholder="/usr/local/bin/backup.sh" /></label>
          <div className="admin-editor-footer">
            <label className="admin-switch"><input type="checkbox" checked={draft.enabled} onChange={(e) => { const enabled = e.target.checked; setDraft((prev) => prev && { ...prev, enabled }); }} /> {t(lang, "cronEnabled")}</label>
            <button className="btn-primary text-[10px]" onClick={() => { void save(); }} disabled={busy !== null}><Save size={11} /> {t(lang, "save")}</button>
          </div>
        </div>
      )}

      <div className="panel-list">
        {!loading && jobs.length === 0 && <div className="panel-empty"><CalendarClock size={20} /><span>{t(lang, "cronEmpty")}</span></div>}
        {jobs.map((job) => {
          const isBusy = busy === job.id;
          return (
            <div className={clsx("panel-item admin-item", !job.enabled && "admin-item-disabled")} key={job.id}>
              <span className={clsx("panel-item-icon admin-state-icon", job.enabled && "admin-state-on")}>{job.enabled ? <Play size={12} /> : <Pause size={12} />}</span>
              <div className="panel-item-copy">
                <div className="panel-item-title font-mono" title={job.command}>{job.command}</div>
                <div className="panel-item-meta"><span className="admin-schedule">{job.schedule}</span> · {t(lang, job.enabled ? "cronEnabled" : "cronDisabled")}</div>
              </div>
              <div className="panel-item-actions">
                <button className="container-action-btn text-ok" onClick={() => run(job)} disabled={isBusy} title={t(lang, "cronRunNow")}>{isBusy ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}</button>
                <button className="container-action-btn" onClick={() => toggle(job)} disabled={isBusy} title={t(lang, job.enabled ? "cronDisable" : "cronEnable")}>{job.enabled ? <Pause size={11} /> : <Play size={11} />}</button>
                <button className="container-action-btn" onClick={() => openEdit(job)} title={t(lang, "cronEdit")}><Edit3 size={11} /></button>
                <button className={clsx("container-action-btn text-bad", armed === job.id && "action-armed")} onClick={() => remove(job)} disabled={isBusy} title={armed === job.id ? t(lang, "confirm") : t(lang, "delete")}>{armed === job.id ? <AlertTriangle size={11} /> : <Trash2 size={11} />}</button>
              </div>
            </div>
          );
        })}
      </div>

      {pending && (
        <UnsavedChangesDialog
          locale={lang}
          title={draft?.command || t(lang, "cronJobs")}
          body={t(lang, "unsavedCronDraft")}
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
