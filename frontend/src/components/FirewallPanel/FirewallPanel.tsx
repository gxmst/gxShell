import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle,
  Loader2,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { types } from "../../../wailsjs/go/models";
import {
  AddFirewallRule,
  DeleteFirewallRule,
  GetFirewallStatus,
  SetFirewallEnabled,
} from "../../../wailsjs/go/app/App";
import { t } from "../../i18n";
import { ConfirmDialog } from "../modals/ConfirmDialog";
import type { Tab, Toast } from "../../types";
import { isRemoteSession } from "../../utils/sessionIdentity";
import {
  deleteLockoutBody,
  groupFirewallRules,
  portCoversSsh,
  ruleNeedsDeleteForce,
  type FirewallRuleGroup,
} from "./firewallGuards";

const PORT_RE = /^\d{1,5}([:\-]\d{1,5})?$/;
const ARM_TIMEOUT_MS = 3000;

type FirewallDialog =
  | { kind: "disable" }
  | { kind: "delete"; group: FirewallRuleGroup }
  | { kind: "deny" };

export function FirewallPanel(props: {
  active?: Tab;
  locale: string;
  onNotify: (text: string, tone?: Toast["tone"]) => void;
}) {
  const lang = props.locale;
  const [status, setStatus] = useState<types.FirewallStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [adding, setAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({
    action: "allow",
    port: "",
    protocol: "tcp",
    source: "",
  });
  const [busyRule, setBusyRule] = useState<string | null>(null);
  const [armedRule, setArmedRule] = useState<string | null>(null);
  const [dialog, setDialog] = useState<FirewallDialog | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const armedTimerRef = useRef<number | null>(null);
  const activeSessionRef = useRef(props.active?.id || "");
  const refreshSeqRef = useRef(0);
  activeSessionRef.current = props.active?.id || "";

  // Every mutation runs behind the previous one. UFW deletes by index and the
  // backend checks a rule before deleting it, so two deletes in flight at once
  // can remove the wrong rule: deleting #3 and #5 together drops the original
  // #6 instead of #5 — and if #6 allowed the SSH port, the session is cut and
  // the lockout guard never ran. The chain also keeps a rejected task from
  // wedging the queue.
  const mutationChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const runExclusive = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const next = mutationChainRef.current.then(task, task);
    mutationChainRef.current = next.catch(() => {});
    return next;
  }, []);

  const onNotifyRef = useRef(props.onNotify);
  onNotifyRef.current = props.onNotify;

  // Only a live remote session has a firewall to inspect. A local terminal or a
  // Markdown document has a tab id too, and polling one only produced
  // "session not found" every interval.
  const sessionId = isRemoteSession(props.active) ? props.active.id : "";

  const refresh = useCallback(async () => {
    const sessionID = sessionId;
    if (!sessionID) return;
    const seq = ++refreshSeqRef.current;
    setLoading(true);
    try {
      const next = await GetFirewallStatus(sessionID);
      if (
        seq !== refreshSeqRef.current ||
        activeSessionRef.current !== sessionID
      )
        return;
      setStatus(next || null);
    } catch (err) {
      if (
        seq !== refreshSeqRef.current ||
        activeSessionRef.current !== sessionID
      )
        return;
      props.onNotify(String(err), "error");
      setStatus(null);
    } finally {
      if (
        seq === refreshSeqRef.current &&
        activeSessionRef.current === sessionID
      )
        setLoading(false);
    }
  }, [sessionId, props.onNotify]);

  useEffect(() => {
    refresh();
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(refresh, 30000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [refresh]);

  // Session change: drop per-session state.
  useEffect(() => {
    setStatus(null);
    setAdding(false);
    setDialog(null);
    setArmedRule(null);
    setBusyRule(null);
    // In-flight flags too: a reply from the host that was on screen must not
    // clear the spinner of an action started on the host replacing it.
    setToggling(false);
    setSubmitting(false);
  }, [props.active?.id]);

  useEffect(() => {
    return () => {
      if (armedTimerRef.current !== null)
        window.clearTimeout(armedTimerRef.current);
    };
  }, []);

  const clearArm = useCallback(() => {
    if (armedTimerRef.current !== null) {
      window.clearTimeout(armedTimerRef.current);
      armedTimerRef.current = null;
    }
    setArmedRule(null);
  }, []);

  const arm = useCallback((key: string) => {
    if (armedTimerRef.current !== null)
      window.clearTimeout(armedTimerRef.current);
    setArmedRule(key);
    armedTimerRef.current = window.setTimeout(() => {
      armedTimerRef.current = null;
      setArmedRule(null);
    }, ARM_TIMEOUT_MS);
  }, []);

  const toggleEnabled = useCallback(async () => {
    const sessionID = props.active?.id;
    if (!sessionID || !status) return;
    if (status.enabled) {
      // Disabling always requires force=true on the backend; ask first.
      setDialog({ kind: "disable" });
      return;
    }
    setToggling(true);
    try {
      const result = await runExclusive(() => SetFirewallEnabled(sessionID, true, false));
      if (activeSessionRef.current !== sessionID) return;
      if (result.status?.backend) setStatus(result.status);
      onNotifyRef.current(
        result.verified
          ? t(lang, "fwEnabledNotice", { port: String(result.status.sshPort || status.sshPort) })
          : t(lang, "fwEnableUnverified", { error: result.verification || "unknown" }),
        result.verified ? "success" : "error",
      );
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      onNotifyRef.current(String(err), "error");
    } finally {
      if (activeSessionRef.current === sessionID) setToggling(false);
    }
  }, [props.active?.id, status, lang, runExclusive]);

  const confirmDisable = useCallback(async () => {
    const sessionID = props.active?.id;
    if (!sessionID) return;
    setDialog(null);
    setToggling(true);
    try {
      const result = await runExclusive(() => SetFirewallEnabled(sessionID, false, true));
      if (activeSessionRef.current !== sessionID) return;
      if (result.status?.backend) setStatus(result.status);
      onNotifyRef.current(
        result.verified ? t(lang, "fwDisabledNotice") : t(lang, "fwDisableUnverified", { error: result.verification || "unknown" }),
        result.verified ? "success" : "error",
      );
    } catch (err) {
      if (activeSessionRef.current !== sessionID) return;
      onNotifyRef.current(String(err), "error");
    } finally {
      if (activeSessionRef.current === sessionID) setToggling(false);
    }
  }, [props.active?.id, lang, runExclusive]);

  const deleteRuleGroup = useCallback(
    async (group: FirewallRuleGroup, force: boolean) => {
      const sessionID = props.active?.id;
      if (!sessionID) return;
      const key = group.key;
      setBusyRule(key);
      try {
        // UFW indices shift after deletion, so remove numbered members from
        // highest to lowest. firewalld rules use index -1 and are raw-addressed.
        // The sequence is one exclusive task: an interleaved delete would shift
        // the indices this list was built from.
        const ordered = [...group.rules].sort((a, b) => b.index - a.index);
        const lastResult = await runExclusive(async () => {
          let last: types.FirewallActionResult | null = null;
          for (const rule of ordered) {
            last = await DeleteFirewallRule(sessionID, rule.index, rule.raw, force);
          }
          return last;
        });
        if (activeSessionRef.current !== sessionID) return;
        if (lastResult?.status?.backend) setStatus(lastResult.status);
        onNotifyRef.current(
          lastResult?.verified ? t(lang, "fwRuleDeleted") : t(lang, "fwDeleteUnverified", { error: lastResult?.verification || "unknown" }),
          lastResult?.verified ? "success" : "error",
        );
      } catch (err) {
        if (activeSessionRef.current !== sessionID) return;
        const msg = String(err);
        // Backend refuses to drop a rule covering the SSH port without force;
        // surface the lockout warning as an explicit second confirmation.
        if (
          !force &&
          (group.rules.some((rule) =>
            ruleNeedsDeleteForce(rule, status?.sshPort || 0),
          ) || /force/i.test(msg))
        ) {
          setDialog({ kind: "delete", group });
        } else {
          onNotifyRef.current(msg, "error");
        }
      } finally {
        if (activeSessionRef.current === sessionID) setBusyRule(null);
      }
    },
    [props.active?.id, status, lang, runExclusive],
  );

  // Every delete is two-step (arm, then execute). Rules covering the SSH port
  // additionally hit the backend's force gate, which opens the strong dialog.
  const onDeleteClick = useCallback(
    (group: FirewallRuleGroup) => {
      const key = group.key;
      if (armedRule !== key) {
        arm(key);
        return;
      }
      clearArm();
      if (
        group.rules.some((rule) =>
          ruleNeedsDeleteForce(rule, status?.sshPort || 0),
        )
      ) {
        setDialog({ kind: "delete", group });
        return;
      }
      deleteRuleGroup(group, false);
    },
    [armedRule, arm, clearArm, deleteRuleGroup, status?.sshPort],
  );

  const submitRule = useCallback(
    async (force: boolean) => {
      const sessionID = props.active?.id;
      if (!sessionID || !status) return;
      const port = form.port.trim();
      if (!PORT_RE.test(port)) {
        onNotifyRef.current(t(lang, "fwInvalidPort"), "error");
        return;
      }
      if (
        !force &&
        form.action === "deny" &&
        portCoversSsh(port, status.sshPort)
      ) {
        setDialog({ kind: "deny" });
        return;
      }
      setSubmitting(true);
      try {
        const result = await runExclusive(() => AddFirewallRule(
          sessionID,
          form.action,
          port,
          form.protocol,
          form.source.trim(),
          force,
        ));
        if (activeSessionRef.current !== sessionID) return;
        if (result.status?.backend) setStatus(result.status);
        onNotifyRef.current(
          result.verified ? t(lang, "fwRuleAdded") : t(lang, "fwAddUnverified", { error: result.verification || "unknown" }),
          result.verified ? "success" : "error",
        );
        setForm((prev) => ({ ...prev, port: "", source: "" }));
      } catch (err) {
        if (activeSessionRef.current !== sessionID) return;
        const msg = String(err);
        if (!force && /force/i.test(msg)) {
          setDialog({ kind: "deny" });
        } else {
          onNotifyRef.current(msg, "error");
        }
      } finally {
        if (activeSessionRef.current === sessionID) setSubmitting(false);
      }
    },
    [props.active?.id, status, form, lang, runExclusive],
  );

  if (!sessionId) {
    return (
      <div className="firewall-panel panel-page">
        <div className="container-empty">
          <Shield size={28} className="text-muted mb-2" />
          <div className="text-[11px] text-muted">
            {t(lang, "noActiveSession")}
          </div>
        </div>
      </div>
    );
  }

  const rules = status?.rules || [];
  const ruleGroups = groupFirewallRules(rules, status?.backend);
  const noBackend = !!status && status.backend === "none";
  const sshPortText = String(status?.sshPort || "");

  return (
    <div className="firewall-panel panel-page">
      <div className="firewall-header panel-page-header">
        <div className="panel-page-heading">
          <span className="panel-page-icon">
            <Shield size={14} />
          </span>
          <span>
            <strong>{t(lang, "firewall")}</strong>
            <small>
              {status && !noBackend
                ? `${status.backend} · ${
                    ruleGroups.length === rules.length
                      ? t(lang, "fwRuleCount", { n: String(rules.length) })
                      : t(lang, "fwGroupedRuleCount", {
                          groups: String(ruleGroups.length),
                          rules: String(rules.length),
                        })
                  }`
                : t(lang, "firewall")}
            </small>
          </span>
        </div>
        <div className="panel-page-actions">
          <button
            className="panel-page-action"
            onClick={refresh}
            disabled={loading}
            title={t(lang, "refresh")}
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
          {status && !noBackend && (
            <button
              className={clsx("panel-page-action", adding && "active")}
              onClick={() => setAdding((v) => !v)}
              title={t(lang, "fwAddRule")}
            >
              <Plus size={11} />
            </button>
          )}
        </div>
      </div>

      {noBackend ? (
        <div className="panel-empty">
          <ShieldOff size={20} />
          <span>{t(lang, "fwBackendNone")}</span>
        </div>
      ) : (
        <>
          {status && (
            <div className="fw-status-card">
              <span
                className={clsx(
                  "fw-status-icon",
                  status.enabled ? "fw-status-icon-on" : "fw-status-icon-off",
                )}
              >
                {status.enabled ? (
                  <ShieldCheck size={15} />
                ) : (
                  <ShieldOff size={15} />
                )}
              </span>
              <div className="fw-status-copy">
                <div className="fw-status-title">
                  <span className="fw-backend">{status.backend}</span>
                  <span
                    className={clsx(
                      "fw-state-tag",
                      status.enabled ? "fw-state-on" : "fw-state-off",
                    )}
                  >
                    {t(
                      lang,
                      status.enabled ? "fwStatusActive" : "fwStatusInactive",
                    )}
                  </span>
                </div>
                <div className="fw-status-meta">
                  {status.defaultPolicy && (
                    <span>
                      {t(lang, "fwDefaultPolicy")}: {status.defaultPolicy}
                    </span>
                  )}
                  <span>
                    {t(lang, "fwSshPort")}: {status.sshPort || "?"}
                  </span>
                </div>
              </div>
              <button
                className={clsx(
                  "fw-toggle-btn",
                  status.enabled && "fw-toggle-btn-danger",
                )}
                onClick={toggleEnabled}
                disabled={toggling}
              >
                {toggling && <Loader2 size={10} className="animate-spin" />}
                {t(lang, status.enabled ? "fwDisable" : "fwEnable")}
              </button>
            </div>
          )}

          {adding && status && (
            <div className="fw-add-form">
              <div className="fw-add-row">
                <select
                  className="input text-[10px]"
                  value={form.action}
                  onChange={(e) => setForm({ ...form, action: e.target.value })}
                >
                  <option value="allow">{t(lang, "fwAllow")}</option>
                  <option value="deny">{t(lang, "fwDeny")}</option>
                </select>
                <input
                  className="input text-[10px] font-mono"
                  value={form.port}
                  placeholder={t(lang, "fwPortPlaceholder")}
                  onChange={(e) => setForm({ ...form, port: e.target.value })}
                />
                <select
                  className="input text-[10px]"
                  value={form.protocol}
                  onChange={(e) =>
                    setForm({ ...form, protocol: e.target.value })
                  }
                >
                  <option value="tcp">tcp</option>
                  <option value="udp">udp</option>
                </select>
              </div>
              <input
                className="input text-[10px] font-mono"
                value={form.source}
                placeholder={t(lang, "fwSourcePlaceholder")}
                onChange={(e) => setForm({ ...form, source: e.target.value })}
              />
              <button
                className="btn-primary w-full text-[10px] py-1"
                onClick={() => submitRule(false)}
                disabled={submitting}
              >
                {submitting ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Plus size={11} />
                )}{" "}
                {t(lang, "fwAddRule")}
              </button>
            </div>
          )}

          <div className="firewall-list panel-list">
            {status && ruleGroups.length === 0 && !loading && (
              <div className="panel-empty">
                <Shield size={20} />
                <span>{t(lang, "fwNoRules")}</span>
              </div>
            )}
            {ruleGroups.map((group) => {
              const { rule, key } = group;
              const isArmed = armedRule === key;
              const busy = busyRule === key;
              return (
                <div key={key} className="fw-rule">
                  <span className={clsx("fw-tag", `fw-tag-${rule.action}`)}>
                    {rule.action}
                  </span>
                  <div className="fw-rule-copy" title={rule.raw}>
                    <div className="fw-rule-port">
                      {rule.port
                        ? `${rule.port}${rule.protocol ? `/${rule.protocol}` : ""}`
                        : rule.protocol || "*"}
                    </div>
                    <div className="fw-rule-src">
                      {rule.source || t(lang, "fwAnywhere")}
                    </div>
                  </div>
                  <span className="fw-family-tags">
                    {group.hasV4 && <span className="fw-family">IPv4</span>}
                    {group.hasV6 && <span className="fw-family">IPv6</span>}
                  </span>
                  <button
                    className={clsx(
                      "container-action-btn text-bad",
                      isArmed && "action-armed",
                    )}
                    onClick={() => onDeleteClick(group)}
                    title={isArmed ? t(lang, "confirm") : t(lang, "delete")}
                    // Every delete button, not just this row's: a second delete
                    // queued behind the first would be applied to indices that
                    // the first one has already shifted.
                    disabled={busyRule !== null}
                  >
                    {busy ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : isArmed ? (
                      <AlertTriangle size={11} />
                    ) : (
                      <Trash2 size={11} />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {dialog?.kind === "disable" && (
        <ConfirmDialog
          locale={lang}
          title={t(lang, "fwDisableTitle")}
          body={t(lang, "fwDisableBody")}
          confirmText={t(lang, "fwDisable")}
          onConfirm={confirmDisable}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          locale={lang}
          title={t(lang, "fwLockoutTitle")}
          body={deleteLockoutBody(dialog.group, status?.sshPort || 0, lang)}
          confirmText={t(lang, "fwProceed")}
          onConfirm={() => {
            const group = dialog.group;
            setDialog(null);
            deleteRuleGroup(group, true);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "deny" && (
        <ConfirmDialog
          locale={lang}
          title={t(lang, "fwLockoutTitle")}
          body={t(lang, "fwDenyLockoutBody", { port: sshPortText })}
          confirmText={t(lang, "fwProceed")}
          onConfirm={() => {
            setDialog(null);
            submitRule(true);
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
