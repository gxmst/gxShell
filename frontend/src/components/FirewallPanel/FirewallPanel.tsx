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
} from "../../../wailsjs/go/main/App";
import { t } from "../../i18n";
import { ConfirmDialog } from "../modals/ConfirmDialog";
import type { Tab, Toast } from "../../types";

const PORT_RE = /^\d{1,5}([:\-]\d{1,5})?$/;
const ARM_TIMEOUT_MS = 3000;

// Does a rule's port spec ("8080", "8000:8100", "8000-8100") cover the SSH port?
function portCoversSsh(port: string, sshPort: number): boolean {
  if (!sshPort || !port) return false;
  const m = port.match(/^(\d{1,5})(?:[:\-](\d{1,5}))?$/);
  if (!m) return false;
  const lo = parseInt(m[1], 10);
  const hi = m[2] ? parseInt(m[2], 10) : lo;
  return sshPort >= Math.min(lo, hi) && sshPort <= Math.max(lo, hi);
}

type FirewallDialog =
  | { kind: "disable" }
  | { kind: "delete"; group: FirewallRuleGroup }
  | { kind: "deny" };

type FirewallRuleGroup = {
  key: string;
  rules: types.FirewallRule[];
  rule: types.FirewallRule;
  hasV4: boolean;
  hasV6: boolean;
};

function groupFirewallRules(
  rules: types.FirewallRule[],
  backend?: string,
): FirewallRuleGroup[] {
  const groups: FirewallRuleGroup[] = [];
  const buckets = new Map<string, FirewallRuleGroup[]>();
  for (const rule of rules) {
    const semanticKey = [
      rule.action,
      rule.port,
      rule.protocol,
      rule.source,
    ].join("\u0000");
    const bucket = buckets.get(semanticKey) || [];
    // Pair one IPv4 and one IPv6 rule. Repeated rules of the same family stay
    // separate instead of being hidden inside an accidental mega-group.
    let group = bucket.find((candidate) =>
      rule.v6 ? !candidate.hasV6 : !candidate.hasV4,
    );
    if (!group) {
      group = {
        key: `${semanticKey}\u0000${bucket.length}`,
        rules: [],
        rule,
        hasV4: false,
        hasV6: false,
      };
      bucket.push(group);
      buckets.set(semanticKey, bucket);
      groups.push(group);
    }
    group.rules.push(rule);
    const firewalldDualFamily =
      backend === "firewalld" && !/family="ipv[46]"/.test(rule.raw || "");
    group.hasV6 ||= rule.v6 || firewalldDualFamily;
    group.hasV4 ||= !rule.v6 || firewalldDualFamily;
    if (!rule.v6) group.rule = rule;
  }
  return groups;
}

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

  const onNotifyRef = useRef(props.onNotify);
  onNotifyRef.current = props.onNotify;

  const refresh = useCallback(async () => {
    const sessionID = props.active?.id;
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
  }, [props.active?.id, props.onNotify]);

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
    if (!props.active?.id || !status) return;
    if (status.enabled) {
      // Disabling always requires force=true on the backend; ask first.
      setDialog({ kind: "disable" });
      return;
    }
    setToggling(true);
    try {
      const result = await SetFirewallEnabled(props.active.id, true, false);
      if (result.status?.backend) setStatus(result.status);
      onNotifyRef.current(
        result.verified
          ? t(lang, "fwEnabledNotice", { port: String(result.status.sshPort || status.sshPort) })
          : (lang === "zh-CN" ? `启用命令已执行，但回读未确认：${result.verification}` : `Enable command completed but did not verify: ${result.verification}`),
        result.verified ? "success" : "error",
      );
    } catch (err) {
      onNotifyRef.current(String(err), "error");
    } finally {
      setToggling(false);
    }
  }, [props.active?.id, status, lang]);

  const confirmDisable = useCallback(async () => {
    if (!props.active?.id) return;
    setDialog(null);
    setToggling(true);
    try {
      const result = await SetFirewallEnabled(props.active.id, false, true);
      if (result.status?.backend) setStatus(result.status);
      onNotifyRef.current(
        result.verified ? t(lang, "fwDisabledNotice") : (lang === "zh-CN" ? `停用命令已执行，但回读未确认：${result.verification}` : `Disable command completed but did not verify: ${result.verification}`),
        result.verified ? "success" : "error",
      );
    } catch (err) {
      onNotifyRef.current(String(err), "error");
    } finally {
      setToggling(false);
    }
  }, [props.active?.id, lang]);

  const deleteRuleGroup = useCallback(
    async (group: FirewallRuleGroup, force: boolean) => {
      if (!props.active?.id) return;
      const key = group.key;
      setBusyRule(key);
      try {
        // UFW indices shift after deletion, so remove numbered members from
        // highest to lowest. firewalld rules use index -1 and are raw-addressed.
        const ordered = [...group.rules].sort((a, b) => b.index - a.index);
        let lastResult: types.FirewallActionResult | null = null;
        for (const rule of ordered) {
          lastResult = await DeleteFirewallRule(
            props.active.id,
            rule.index,
            rule.raw,
            force,
          );
        }
        if (lastResult?.status?.backend) setStatus(lastResult.status);
        onNotifyRef.current(
          lastResult?.verified ? t(lang, "fwRuleDeleted") : (lang === "zh-CN" ? `删除命令已执行，但回读未确认：${lastResult?.verification || "unknown"}` : `Delete command completed but did not verify: ${lastResult?.verification || "unknown"}`),
          lastResult?.verified ? "success" : "error",
        );
      } catch (err) {
        const msg = String(err);
        // Backend refuses to drop a rule covering the SSH port without force;
        // surface the lockout warning as an explicit second confirmation.
        if (
          !force &&
          (group.rules.some((rule) =>
            portCoversSsh(rule.port, status?.sshPort || 0),
          ) || /force/i.test(msg))
        ) {
          setDialog({ kind: "delete", group });
        } else {
          onNotifyRef.current(msg, "error");
        }
      } finally {
        setBusyRule(null);
      }
    },
    [props.active?.id, status, lang],
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
          portCoversSsh(rule.port, status?.sshPort || 0),
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
      if (!props.active?.id || !status) return;
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
        const result = await AddFirewallRule(
          props.active.id,
          form.action,
          port,
          form.protocol,
          form.source.trim(),
          force,
        );
        if (result.status?.backend) setStatus(result.status);
        onNotifyRef.current(
          result.verified ? t(lang, "fwRuleAdded") : (lang === "zh-CN" ? `添加命令已执行，但回读未确认：${result.verification}` : `Add command completed but did not verify: ${result.verification}`),
          result.verified ? "success" : "error",
        );
        setForm((prev) => ({ ...prev, port: "", source: "" }));
      } catch (err) {
        const msg = String(err);
        if (!force && /force/i.test(msg)) {
          setDialog({ kind: "deny" });
        } else {
          onNotifyRef.current(msg, "error");
        }
      } finally {
        setSubmitting(false);
      }
    },
    [props.active?.id, status, form, lang],
  );

  if (!props.active?.id) {
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
                    disabled={busy}
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
          body={t(lang, "fwDeleteLockoutBody", { port: sshPortText })}
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
