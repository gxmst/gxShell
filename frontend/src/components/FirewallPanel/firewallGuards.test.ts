import { describe, expect, it } from "vitest";
import { types } from "../../../wailsjs/go/models";
import { deleteLockoutBody, ruleNeedsDeleteForce } from "./firewallGuards";

function rule(partial: Partial<types.FirewallRule>): types.FirewallRule {
  return types.FirewallRule.createFrom({
    index: 1,
    raw: "",
    action: "allow",
    port: "",
    protocol: "",
    source: "",
    v6: false,
    ...partial,
  });
}

describe("ruleNeedsDeleteForce", () => {
  it("guards an allow rule covering the SSH port", () => {
    expect(ruleNeedsDeleteForce(rule({ action: "allow", port: "22" }), 22)).toBe(true);
    expect(ruleNeedsDeleteForce(rule({ action: "allow", port: "20:25" }), 22)).toBe(true);
  });

  it("guards a limit rule, which closes the port just as surely", () => {
    expect(ruleNeedsDeleteForce(rule({ action: "limit", port: "22" }), 22)).toBe(true);
  });

  it("guards an allow rule whose port could not be parsed", () => {
    // `ufw allow OpenSSH` and `22/tcp on eth0` both parse with no port.
    expect(ruleNeedsDeleteForce(rule({ action: "allow", port: "" }), 22)).toBe(true);
    expect(ruleNeedsDeleteForce(rule({ action: "limit", port: "" }), 22)).toBe(true);
  });

  it("leaves unrelated rules alone", () => {
    expect(ruleNeedsDeleteForce(rule({ action: "allow", port: "8080" }), 22)).toBe(false);
    // A deny is not what keeps the session reachable.
    expect(ruleNeedsDeleteForce(rule({ action: "deny", port: "22" }), 22)).toBe(false);
    expect(ruleNeedsDeleteForce(rule({ action: "reject", port: "" }), 22)).toBe(false);
    // UDP cannot carry this SSH session.
    expect(ruleNeedsDeleteForce(rule({ action: "allow", port: "22", protocol: "udp" }), 22)).toBe(false);
  });

  it("matches the backend comparison against the server-side port", () => {
    // The profile dials 20022 through a forward; sshd listens on 22. The rule
    // that matters is the one on 22.
    expect(ruleNeedsDeleteForce(rule({ action: "allow", port: "22" }), 22)).toBe(true);
    expect(ruleNeedsDeleteForce(rule({ action: "allow", port: "20022" }), 22)).toBe(false);
  });
});

describe("deleteLockoutBody", () => {
  const group = (rules: types.FirewallRule[]) => ({
    key: "k",
    rules,
    rule: rules[0],
    hasV4: true,
    hasV6: false,
  });

  it("names the port when a rule's port is known", () => {
    const body = deleteLockoutBody(group([rule({ action: "allow", port: "22" })]), 22, "en");
    expect(body).toContain("22");
  });

  it("does not claim a port when the rule's port could not be read", () => {
    const body = deleteLockoutBody(group([rule({ action: "allow", port: "" })]), 22, "en");
    expect(body).not.toContain("{port}");
    expect(body).not.toContain("(22)");
    expect(body.toLowerCase()).toContain("could not be read");
  });

  it("falls back to the port when the group also has a rule that names it", () => {
    const body = deleteLockoutBody(
      group([rule({ action: "allow", port: "" }), rule({ action: "allow", port: "22" })]),
      22,
      "en",
    );
    expect(body).toContain("22");
  });
});
