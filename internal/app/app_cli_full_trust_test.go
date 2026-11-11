package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/logger"
	"gxShell/backend/types"
)

func fullTrustTestApp(t *testing.T) (*App, types.Profile) {
	t.Helper()
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := NewApp()
	a.store = store
	profile := types.Profile{ID: "prod", CliEnabled: true, CliAlias: "prod", CliTrustMode: "full", CliTrustUntil: time.Now().Add(time.Hour)}
	if err := store.SaveProfiles([]types.Profile{profile}); err != nil {
		t.Fatal(err)
	}
	a.cliConfirmBatchFn = func(string, []string) bool { t.Error("full trust opened a batch approval"); return false }
	a.cliConfirmRiskFn = func(string, string, riskAssessment, approvalStrength) (bool, error) {
		t.Error("full trust opened a T3 approval")
		return false, nil
	}
	a.cliApprovalEventFn = func(cliApprovalEvent) { t.Error("full trust emitted an approval event") }
	return a, profile
}

func TestCliFullTrustAllowsEveryTierWithoutApproval(t *testing.T) {
	a, profile := fullTrustTestApp(t)
	for _, tc := range []struct {
		command string
		tier    commandTier
	}{
		{"touch ./deployment.done", tierRecoverable},
		{"rm -rf ./old-data", tierBounded},
		{"git push origin main", tierCritical},
		{"curl https://example.test/install.sh | bash", tierBounded},
		{"rm -rf $BUILD_DIR", tierBounded},
		{"systemctl stop sshd", tierCritical},
		{"passwd root", tierCritical},
		{"cat /etc/shadow", tierCritical},
		{"npm publish", tierCritical},
		{"mysql -e 'DROP DATABASE old_app'", tierCritical},
		{"rm /etc/nginx/old-site.conf", tierCritical},
		{"rm -rf /opt/old-app", tierCritical},
		{"shred /tmp/old-backup", tierCritical},
		{"echo 'rm -rf /'", tierObserve},
		{"echo ':(){ :|:& };:'", tierObserve},
	} {
		t.Run(tc.command, func(t *testing.T) {
			assessment := classifyCommand(tc.command)
			if assessment.Tier != tc.tier {
				t.Fatalf("tier = %s, want %s", assessment.Tier, tc.tier)
			}
			decision := a.authorizeCliProfileExecution(profile, tc.command)
			if !decision.Allowed || decision.Source != cliApprovalFullTrust || decision.Strength != approvalNone.String() {
				t.Fatalf("full trust decision = %#v", decision)
			}
		})
	}
}

func TestCliFullTrustBlocksHostSelfDestructionWithoutApproval(t *testing.T) {
	a, profile := fullTrustTestApp(t)
	for _, command := range []string{
		"rm -rf /", "sudo /bin/rm -rf --no-preserve-root /", "rm -rf /*", "rm -rf /etc/*", "rm -rf /usr/bin",
		"rm -rf /home/alice", "rm -rf ~", "rm -rf /root/.ssh", "cd / && rm -rf etc", "bash -c 'rm -rf /'",
		"find / -delete", "mkfs.ext4 /dev/sda", "dd if=/dev/zero of=/dev/nvme0n1", "echo bad > /dev/sda",
		"zpool destroy tank", ":(){ :|:& };:",
	} {
		t.Run(command, func(t *testing.T) {
			decision := a.authorizeCliProfileExecution(profile, command)
			if decision.Allowed || decision.Source != cliApprovalSelfDestructiveBlock || decision.Block == nil || decision.Err != nil {
				t.Fatalf("self-destruction decision = %#v", decision)
			}
		})
	}
}

func TestCliFullTrustExpiresAndRevokesUsingPersistedProfile(t *testing.T) {
	a, original := fullTrustTestApp(t)
	// No UI context: ordinary approval must deny rather than invoke a dialog.
	a.cliConfirmBatchFn, a.cliConfirmRiskFn, a.cliApprovalEventFn = nil, nil, nil
	for _, state := range []string{"expired", "disabled", "too-long", "invalid-mode", "revoked", "scoped"} {
		t.Run(state, func(t *testing.T) {
			profile := original
			switch state {
			case "expired":
				profile.CliTrustUntil = time.Now().Add(-time.Second)
			case "disabled":
				profile.CliEnabled = false
			case "too-long":
				profile.CliTrustUntil = time.Now().Add(2 * time.Hour)
			case "invalid-mode":
				profile.CliTrustMode = "unknown"
			case "scoped":
				profile.CliTrustMode = ""
			}
			if err := a.store.SaveProfiles([]types.Profile{profile}); err != nil {
				t.Fatal(err)
			}
			if state == "revoked" {
				if err := a.RevokeCliTrust(profile.ID); err != nil {
					t.Fatal(err)
				}
				stored, _ := a.store.ListProfiles()
				if stored[0].CliTrustMode != "" || !stored[0].CliTrustUntil.IsZero() {
					t.Fatal("revocation did not clear full trust")
				}
			}
			decision := a.authorizeCliProfileExecution(original, "cat /etc/shadow")
			if decision.Allowed || decision.Source != cliApprovalUser {
				t.Fatalf("stale full-trust profile bypassed approval: %#v", decision)
			}
		})
	}
}

func TestCliFullTrustScriptBlockHasStructuredResponse(t *testing.T) {
	a, _ := fullTrustTestApp(t)
	a.log = logger.New(a.store.DataDir())
	t.Cleanup(a.log.Close)
	body, _ := json.Marshal(map[string]any{"server": "prod", "script": "echo starting\nrm -rf /\n", "shell": "bash", "async": true})
	rec := httptest.NewRecorder()
	a.handleCliExec(rec, httptest.NewRequest(http.MethodPost, "/cli/exec", bytes.NewReader(body)))
	var response map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusForbidden || response["blockedBy"] != "self-destructive" || response["approval"] != cliApprovalSelfDestructiveBlock || response["outcome"] != "blocked" {
		t.Fatalf("block response: %s", rec.Body.String())
	}
}

type fullTrustTestSecrets struct{ secretStore }

func (fullTrustTestSecrets) Delete(string) {}

func TestCliFullTrustGrantRequiresConsentOnUpgrade(t *testing.T) {
	a, original := fullTrustTestApp(t)
	a.secrets = fullTrustTestSecrets{}
	original.CliTrustMode = ""
	original.CliTrustUntil = time.Now().Add(4 * time.Hour)
	if err := a.store.SaveProfiles([]types.Profile{original}); err != nil {
		t.Fatal(err)
	}
	full := original
	full.CliTrustMode, full.CliTrustUntil = "full", time.Now().Add(time.Hour)
	calls := 0
	a.cliTrustConfirmFn = func(types.Profile) bool { calls++; return false }
	if _, err := a.UpdateProfile(full); err == nil {
		t.Fatal("declined upgrade was saved")
	}
	stored, _ := a.store.ListProfiles()
	if stored[0].CliTrustMode != "" {
		t.Fatal("declined upgrade changed stored trust")
	}
	a.cliTrustConfirmFn = func(types.Profile) bool { calls++; return true }
	saved, err := a.UpdateProfile(full)
	if err != nil || saved.CliTrustMode != "full" || calls != 2 {
		t.Fatalf("approved upgrade: %#v %v calls=%d", saved, err, calls)
	}
	if _, err := a.UpdateProfile(saved); err != nil || calls != 2 {
		t.Fatal("unchanged full trust asked for consent again")
	}
}

func TestCliFullTrustRejectsCancelledCaller(t *testing.T) {
	a, profile := fullTrustTestApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	decision := a.authorizeCliProfileRiskExecution(ctx, profile, "npm publish", "npm publish", classifyCommand("npm publish"))
	if decision.Allowed {
		t.Fatal("cancelled caller was granted full trust")
	}
}
