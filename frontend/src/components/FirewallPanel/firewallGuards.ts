import { types } from "../../../wailsjs/go/models";
import { t } from "../../i18n";

// A group of firewall rules that the panel presents as one row: a rule and its
// IPv4/IPv6 twin, when the backend reports them separately.
export type FirewallRuleGroup = {
  key: string;
  rules: types.FirewallRule[];
  rule: types.FirewallRule;
  hasV4: boolean;
  hasV6: boolean;
};

// Does a rule's port spec ("8080", "8000:8100", "8000-8100") cover the SSH port?
export function portCoversSsh(port: string, sshPort: number): boolean {
  if (!sshPort || !port) return false;
  const m = port.match(/^(\d{1,5})(?:[:\-](\d{1,5}))?$/);
  if (!m) return false;
  const lo = parseInt(m[1], 10);
  const hi = m[2] ? parseInt(m[2], 10) : lo;
  return sshPort >= Math.min(lo, hi) && sshPort <= Math.max(lo, hi);
}

// Mirrors the backend's guardAllowDeletion, so the strong confirmation appears
// on the click rather than only after a rejected round trip.
//
// Two cases beyond a plain "allow 22" matter:
//   - "limit" is an allow with rate limiting, and dropping it closes the port
//     just as surely as dropping an allow;
//   - a rule whose port could not be parsed — `ufw allow OpenSSH` (the Ubuntu
//     default), `22/tcp on eth0` — may still be the only thing keeping this
//     session reachable, and the backend cannot tell either, so it guards
//     those too.
export function ruleNeedsDeleteForce(
  rule: types.FirewallRule,
  sshPort: number,
): boolean {
  const action = (rule.action || "").toLowerCase();
  if (action !== "allow" && action !== "limit") return false;
  if (!rule.port) return true;
  // This session is TCP, so a udp rule cannot be carrying it. The backend's
  // ruleCoversPort ignores udp for the same reason.
  if ((rule.protocol || "").toLowerCase() === "udp") return false;
  return portCoversSsh(rule.port, sshPort);
}

// The lockout dialog normally names the port at risk. When the only reason a
// rule is guarded is that its port could not be read, there is no port to name
// — and claiming one would misstate why we are asking.
export function deleteLockoutBody(
  group: FirewallRuleGroup,
  sshPort: number,
  lang: string,
): string {
  const named = group.rules.some((rule) => portCoversSsh(rule.port, sshPort));
  const unparsed = group.rules.some(
    (rule) => ruleNeedsDeleteForce(rule, sshPort) && !rule.port,
  );
  if (!named && unparsed) return t(lang, "fwDeleteUnknownPortBody");
  return t(lang, "fwDeleteLockoutBody", { port: String(sshPort || "") });
}

// Pairs each rule with its IPv4/IPv6 twin so the list shows one row per logical
// rule. Repeated rules of the same family stay separate instead of collapsing
// into an accidental mega-group.
export function groupFirewallRules(
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
    // Pair one IPv4 and one IPv6 rule.
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
