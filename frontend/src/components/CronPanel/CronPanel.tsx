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
} from "../../../wailsjs/go/main/App";
import { t } from "../../i18n";
import type { Tab, Toast } from "../../types";

const ARM_TIMEOUT_MS = 3000;

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
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({
    schedule: "0 3 * * *",
    command: "",
    enabled: true,
  });
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
  }, [props.active?.id, props.onNotify]);

  useEffect(() => {
    refresh();
    return () => {
      if (armedTimerRef.current !== null) window.clearTimeout(armedTimerRef.current);
    };
  }, [refresh]);

  useEffect(() => {
    setJobs([]);
    setEditing(null);
    setArmed(null);
  }, [props.active?.id]);

  const openNew = () => {
    setEditing("");
    setForm({ schedule: "0 3 * * *", command: "", enabled: true });
  };

  const openEdit = (job: types.CronJob) => {
    setEditing(job.id);
    setForm({ schedule: job.schedule, command: job.command, enabled: job.enabled });
  };

  const save = async () => {
    if (!props.active?.id) return;
    setBusy(editing || "new");
    try {
      await SaveCronJob(props.active.id, editing || "", form.schedule, form.command, form.enabled);
      props.onNotify(t(lang, "cronSaved"), "success");
      setEditing(null);
      await refresh();
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (job: types.CronJob) => {
    if (!props.active?.id) return;
    setBusy(job.id);
    try {
      await SetCronJobEnabled(props.active.id, job.id, !job.enabled);
      await refresh();
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const run = async (job: types.CronJob) => {
    if (!props.active?.id) return;
    setBusy(job.id);
    try {
      const output = await RunCronJob(props.active.id, job.id);
      const summary = (output || "").trim().slice(0, 180);
      props.onNotify(summary ? `${t(lang, "cronRunOk")}: ${summary}` : t(lang, "cronRunOk"), "success");
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (job: types.CronJob) => {
    if (!props.active?.id) return;
    if (armed !== job.id) {
      setArmed(job.id);
      if (armedTimerRef.current !== null) window.clearTimeout(armedTimerRef.current);
      armedTimerRef.current = window.setTimeout(() => setArmed(null), ARM_TIMEOUT_MS);
      return;
    }
    setArmed(null);
    setBusy(job.id);
    try {
      await DeleteCronJob(props.active.id, job.id);
      props.onNotify(t(lang, "cronDeleted"), "success");
      await refresh();
    } catch (err) {
      props.onNotify(String(err), "error");
    } finally {
      setBusy(null);
    }
  };

  if (!props.active?.id) {
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

      {editing !== null && (
        <div className="admin-editor cron-editor">
          <div className="admin-editor-title"><span>{editing ? t(lang, "cronEdit") : t(lang, "cronAdd")}</span><button className="mini-btn" onClick={() => setEditing(null)}><X size={10} /></button></div>
          <label className="field-label"><span className="field-label-text">{t(lang, "cronSchedule")}</span><input className="input font-mono text-[10px]" value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} placeholder="0 3 * * *" /></label>
          <label className="field-label"><span className="field-label-text">{t(lang, "command")}</span><textarea className="input admin-command-input font-mono text-[10px]" value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} placeholder="/usr/local/bin/backup.sh" /></label>
          <div className="admin-editor-footer">
            <label className="admin-switch"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> {t(lang, "cronEnabled")}</label>
            <button className="btn-primary text-[10px]" onClick={save} disabled={busy !== null}><Save size={11} /> {t(lang, "save")}</button>
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
    </div>
  );
}
