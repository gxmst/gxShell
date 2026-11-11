package app

import "testing"

func TestScopedTrustNeverAutoApprovesEquivalentCriticalEffects(t *testing.T) {
	for _, command := range []string{
		"rm -rf /var/lib", "rm -rf /var", "find /var -delete", "mv /var /var.old", "chmod -R 000 /var",
		": > /etc/passwd", "truncate -s 0 /etc/passwd", "truncate -s 0 /etc/fstab", "truncate -s 0 /etc/ssh/sshd_config",
		"iptables -F", "ufw deny 22", "ufw reset", "firewall-cmd --panic-on", "firewall-cmd --list-all --panic-on",
		"docker volume rm db", "docker compose down -v", "usermod -L root", "kill -9 -1", "pkill sshd",
		"cat /proc/1/environ", "kubectl get secret db -o yaml", "docker inspect app", "cat /etc/wireguard/wg0.conf",
	} {
		assessment := classifyCommand(command)
		if assessment.requiredApproval(true) != approvalClick {
			t.Errorf("scoped trust auto-approved %q: %s", command, assessment.Tier)
		}
	}
}

func TestFullTrustBlocksCriticalEffectsThroughShellVariants(t *testing.T) {
	for _, command := range []string{
		"mkfs.ext4 /dev/sda", "bash -c 'mkfs.ext4 /dev/sda'", "bash --norc -c 'mkfs.ext4 /dev/sda'",
		"rm -rf /var/lib", "find /var -delete", "mv /etc /etc.bak", "chmod -R 000 /", "truncate -s 0 /etc/passwd",
		"rm -f /etc/passwd /etc/shadow", "rm -f ~/.ssh/authorized_keys", "lvremove -f vg0/root", "cryptsetup luksFormat /dev/sda2",
	} {
		if _, blocked := cliSelfDestructiveBlock(command, classifyCommand(command)); !blocked {
			t.Errorf("full trust missed %q", command)
		}
	}
}

func TestFullTrustStillAllowsNamedCredentialsWithoutApproval(t *testing.T) {
	a, profile := fullTrustTestApp(t)
	assessment := classifyCommand("printenv")
	addNamedCredentialRisk(&assessment, []string{"API_KEY=secret://registered"})
	decision := a.authorizeCliProfileRiskExecution(t.Context(), profile, "printenv", "printenv", assessment)
	if !decision.Allowed || decision.Source != cliApprovalFullTrust {
		t.Fatalf("full trust prompted for credential: %#v", decision)
	}
}
