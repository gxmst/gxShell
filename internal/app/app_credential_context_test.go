package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"gxShell/backend/ai"
	"gxShell/backend/config"
	"gxShell/backend/logger"
	"gxShell/backend/secrets"
	sshmanager "gxShell/backend/ssh"
	"gxShell/backend/types"
)

type contextTestVault struct {
	secretStore
	mu        sync.Mutex
	values    map[string]string
	passwords map[string]string
	fail      bool
	writeFail bool
	reads     int
}

func (v *contextTestVault) NamedNames(namespace string) ([]string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.fail {
		return nil, errors.New("unavailable")
	}
	var names []string
	for name := range v.values {
		names = append(names, name)
	}
	sort.Strings(names)
	return names, nil
}
func (v *contextTestVault) GetNamed(namespace, name string) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.reads++
	if v.fail {
		return "", errors.New("unavailable")
	}
	return v.values[name], nil
}
func (v *contextTestVault) GetPassword(id string) (string, error) { return v.passwords[id], nil }
func (v *contextTestVault) GetPassphrase(string) (string, error)  { return "", nil }
func (v *contextTestVault) ApplyMigration(updates []secrets.Value, commit func() error) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.fail || v.writeFail {
		return errors.New("unavailable")
	}
	for _, update := range updates {
		name := strings.TrimPrefix(update.ID, "named:cli:")
		if update.Expected != nil && v.values[name] != *update.Expected {
			return errors.New("changed")
		}
		v.values[name] = update.Text
	}
	return commit()
}
func contextProtectionTestApp(t *testing.T) (*App, *contextTestVault) {
	t.Helper()
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	v := &contextTestVault{values: map[string]string{}, passwords: map[string]string{}}
	a := NewApp()
	a.store = store
	a.secrets = v
	return a, v
}

func TestCredentialCaptureReusesValuesAcrossResultsAndCanExecuteReferences(t *testing.T) {
	a, v := contextProtectionTestApp(t)
	v.passwords["jump"] = "jump-password-canary"
	if err := a.store.SaveProfiles([]types.Profile{{ID: "jump", RememberPassword: true}}); err != nil {
		t.Fatal(err)
	}
	result := sshmanager.CommandExecutionResult{Stdout: `{"API_KEY":"api-canary","rootPassword":"root-canary","ubuntuPassword":"ubuntu-canary"}`, Stderr: "jump-password-canary", Output: "api-canary"}
	a.protectCredentialResult(&result)
	for _, value := range []string{"api-canary", "root-canary", "ubuntu-canary", "jump-password-canary"} {
		if strings.Contains(result.Stdout+result.Stderr+result.Output, value) {
			t.Fatal("plaintext escaped result boundary")
		}
	}
	entries, err := a.ListNamedSecrets()
	if err != nil || len(entries) != 4 {
		t.Fatalf("captured inventory: %v %v", entries, err)
	}
	var apiRef string
	for _, entry := range entries {
		if v.values[entry.Alias] == "api-canary" {
			apiRef = entry.Reference
		}
	}
	values, _, err := a.resolveCliSecretRefs(map[string]string{"API_KEY": apiRef})
	if err != nil || values["API_KEY"] != "api-canary" {
		t.Fatal("captured reference cannot be used")
	}
	if again := a.protectCredentialTexts("api-canary")[0]; again != apiRef || len(v.values) != 4 {
		t.Fatal("unlabeled duplicate was not reused")
	}
}

func TestCredentialProtectionPreventsGatewayContextDisclosureForEveryProtocol(t *testing.T) {
	for _, provider := range []ai.Provider{ai.ProviderOpenAI, ai.ProviderAnthropic, ai.ProviderGemini, ai.ProviderOllama} {
		t.Run(string(provider), func(t *testing.T) {
			a, v := contextProtectionTestApp(t)
			var seen atomic.Bool
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				body, _ := io.ReadAll(r.Body)
				seen.Store(true)
				if strings.Contains(string(body), "gateway-context-canary") || strings.Contains(string(body), "gateway-auth-canary") {
					t.Error("gateway received plaintext credential in request body")
				}
				if !strings.Contains(string(body), "secret://auto-") {
					t.Error("gateway did not receive usable reference")
				}
				if provider == ai.ProviderOpenAI && r.Header.Get("Authorization") != "Bearer gateway-auth-canary" {
					t.Error("transport authentication was modified")
				}
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"test completed"}`))
			}))
			defer server.Close()
			manager := ai.NewManager()
			manager.SetRequestProtector(a.protectAIRequest)
			req := ai.ChatRequest{Context: "API_KEY=gateway-context-canary", Messages: []ai.Message{{Role: "user", Content: "check the API"}}}
			_ = manager.ChatWithConfig(context.Background(), ai.Config{Provider: provider, Endpoint: server.URL, Model: "test", APIKey: "gateway-auth-canary"}, req, func(ai.ChatResponse) {})
			if !seen.Load() || len(v.values) != 1 || req.Context != "API_KEY=gateway-context-canary" {
				t.Fatal("protection skipped or mutated the caller copy")
			}
		})
	}
}

func TestCredentialFileUnlabeledValueBecomesUsableReference(t *testing.T) {
	a, v := contextProtectionTestApp(t)
	result := sshmanager.CommandExecutionResult{Stdout: "unlabeled-password-canary\n", Output: "unlabeled-password-canary\n"}
	a.protectCredentialResult(&result, "cat /root/password.txt")
	if !strings.HasPrefix(result.Stdout, "secret://") || strings.Contains(result.Output, "canary") || len(v.values) != 1 {
		t.Fatal("unlabeled sensitive file escaped capture")
	}
	value, _, err := a.resolveCliSecretRefs(map[string]string{"PASSWORD": result.Stdout})
	if err != nil || value["PASSWORD"] != "unlabeled-password-canary" {
		t.Fatal("scalar credential file retained its line terminator")
	}
}

func TestCredentialCaptureWriteFailureMasksUnlabeledDuplicates(t *testing.T) {
	a, v := contextProtectionTestApp(t)
	v.writeFail = true
	result := sshmanager.CommandExecutionResult{Stdout: "write-failed-canary", Stderr: "PASSWORD=write-failed-canary"}
	a.protectCredentialResult(&result)
	if strings.Contains(result.Stdout+result.Stderr, "canary") || strings.Contains(result.Stdout+result.Stderr, "secret://") {
		t.Fatal("failed capture leaked a duplicate or returned an unusable reference")
	}
}

func TestCredentialReferenceExecutesOverSSHAndEchoStaysOutOfCLIContext(t *testing.T) {
	const canary = "ssh-api-credential-canary"
	var received atomic.Bool
	profile, known := inspectionSSHFixture(t, func(script string) (string, uint32, bool) {
		received.Store(true)
		if !strings.HasPrefix(script, "export API_KEY="+canary+"\n") || !strings.Contains(script, `printf '%s' "$API_KEY"`) {
			t.Error("SSH stdin did not receive the bound original credential")
		}
		return `{"api_key":"` + canary + `","ok":true}`, 0, true
	})
	a, v := contextProtectionTestApp(t)
	v.values["api-credential"] = canary
	profile.CliEnabled, profile.CliAlias, profile.CliTrustMode, profile.CliTrustUntil = true, "probe", "full", time.Now().Add(time.Hour)
	if err := a.store.SaveProfiles([]types.Profile{profile}); err != nil {
		t.Fatal(err)
	}
	a.log = logger.New(a.store.DataDir())
	t.Cleanup(a.log.Close)
	a.ssh = sshmanager.NewManager(known, func(string, any) {}, nil)
	info, err := a.ssh.Connect(profile, 5, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.ssh.Disconnect(info.ID) })
	body, _ := json.Marshal(map[string]any{"server": "probe", "command": `printf '%s' "$API_KEY"`, "secrets": map[string]string{"API_KEY": "secret://api-credential"}})
	w := httptest.NewRecorder()
	a.handleCliExec(w, httptest.NewRequest("POST", "/cli/exec", bytes.NewReader(body)))
	if !received.Load() || w.Code != http.StatusOK || strings.Contains(w.Body.String(), canary) || !strings.Contains(w.Body.String(), "secret://api-credential") || !strings.Contains(w.Body.String(), `"approval":"full-trust"`) {
		t.Fatalf("SSH credential execution/response boundary failed: %s", w.Body.String())
	}
}

func TestCredentialProtectionCoversHistoryArgumentsAndStorageFailure(t *testing.T) {
	a, v := contextProtectionTestApp(t)
	req := ai.ChatRequest{Messages: []ai.Message{
		{Role: "user", Content: "history-canary"},
		{Role: "tool", Content: "PASSWORD=history-canary"},
		{Role: "assistant", ToolCalls: []ai.ToolCall{{Function: ai.FunctionCall{Name: "execute_command", Arguments: `{"command":"echo history-canary"}`}}}},
	}}
	protected := a.protectAIRequest(ai.Config{}, req)
	encoded, _ := json.Marshal(protected)
	if bytes.Contains(encoded, []byte("history-canary")) || req.Messages[0].Content != "history-canary" {
		t.Fatal("history secret leaked or caller mutated")
	}
	if !json.Valid([]byte(protected.Messages[2].ToolCalls[0].Function.Arguments)) {
		t.Fatal("tool arguments corrupted")
	}
	v.fail = true
	if output := a.protectCredentialTexts("unlabeled-sensitive-canary")[0]; strings.Contains(output, "canary") || !strings.Contains(output, "withheld") {
		t.Fatal("vault failure was not closed")
	}
}

func TestNamedCredentialApprovalRunsBeforeSecretResolution(t *testing.T) {
	for _, trusted := range []bool{false, true} {
		a, v := contextProtectionTestApp(t)
		a.log = logger.New(a.store.DataDir())
		defer a.log.Close()
		profile := types.Profile{ID: "prod", CliAlias: "prod", CliEnabled: true}
		if trusted {
			profile.CliTrustUntil = time.Now().Add(time.Hour)
		}
		if err := a.store.SaveProfiles([]types.Profile{profile}); err != nil {
			t.Fatal(err)
		}
		calls := 0
		a.cliConfirmRiskFn = func(string, string, riskAssessment, approvalStrength) (bool, error) {
			calls++
			if v.reads != 0 {
				t.Error("credential read before approval")
			}
			return false, nil
		}
		body := `{"server":"prod","command":"printenv","secrets":{"API_KEY":"secret://missing"}}`
		w := httptest.NewRecorder()
		a.handleCliExec(w, httptest.NewRequest("POST", "/cli/exec", strings.NewReader(body)))
		if calls != 1 || v.reads != 0 || w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), `"riskTier":"T3"`) {
			t.Fatalf("credential approval boundary failed: %s", w.Body.String())
		}
	}
}

func TestCredentialCaptureParallelResultsShareReference(t *testing.T) {
	a, v := contextProtectionTestApp(t)
	var wg sync.WaitGroup
	for range 12 {
		wg.Add(1)
		go func() { defer wg.Done(); a.protectCredentialTexts("PASSWORD=parallel-canary") }()
	}
	wg.Wait()
	if len(v.values) != 1 {
		t.Fatal("parallel captures duplicated credential")
	}
}

func TestCredentialPinnedProviderKeyInContextRemainsUsable(t *testing.T) {
	a, _ := contextProtectionTestApp(t)
	const key = "pinned-provider-key-canary"
	protected := a.protectAIRequest(ai.Config{APIKey: key}, ai.ChatRequest{Messages: []ai.Message{{Role: "user", Content: key}}})
	ref := protected.Messages[0].Content
	if !strings.HasPrefix(ref, "secret://") {
		t.Fatal("provider key in context was discarded instead of captured")
	}
	values, _, err := a.resolveCliSecretRefs(map[string]string{"API_KEY": ref})
	if err != nil || values["API_KEY"] != key {
		t.Fatal("captured provider key cannot be used")
	}
}
