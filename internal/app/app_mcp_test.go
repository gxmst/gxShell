package app

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gxShell/backend/config"
	"gxShell/backend/logger"
	"gxShell/backend/types"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpAuthTransport struct{ token string }

func (t mcpAuthTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.Header.Set("Authorization", "Bearer "+t.token)
	return http.DefaultTransport.RoundTrip(clone)
}

func TestMCPHTTPUsesCLIProfileVisibilityAndPolicy(t *testing.T) {
	store, err := config.NewStoreAt(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp()
	app.store = store
	app.log = logger.New(store.DataDir())
	t.Cleanup(app.log.Close)
	if err := store.SaveProfiles([]types.Profile{
		{ID: "allowed", CliEnabled: true, CliAlias: "prod", Host: "192.0.2.1", Username: "hidden-user"},
		{ID: "disabled", CliAlias: "private", Host: "192.0.2.2"},
	}); err != nil {
		t.Fatal(err)
	}
	host := httptest.NewServer(app.newCliHandler("test-token"))
	defer host.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "integration-test"}, nil)
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: host.URL + "/mcp", HTTPClient: &http.Client{Transport: mcpAuthTransport{"test-token"}},
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "gxshell_list_servers", Arguments: map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	text := result.Content[0].(*mcp.TextContent).Text
	if result.IsError || !strings.Contains(text, "prod") || strings.Contains(text, "private") || strings.Contains(text, "192.0.2") || strings.Contains(text, "hidden-user") {
		t.Fatalf("profile visibility = %s", text)
	}
	// A disabled profile must be rejected by the existing CLI handler, before
	// any SSH connection or approval dialog can occur.
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "gxshell_execute_command", Arguments: map[string]any{"server": "private", "command": "uptime"}})
	if err != nil {
		t.Fatal(err)
	}
	if !result.IsError {
		t.Fatal("disabled profile accepted")
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["requestProtected"] != true || payload["requestId"] == "" {
		t.Fatalf("missing request protection: %#v", payload)
	}
	requestID := payload["requestId"].(string)
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "gxshell_execute_command", Arguments: map[string]any{"server": "private", "command": "uptime", "requestId": requestID}})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["replayed"] != true {
		t.Fatalf("retry did not replay: %#v", payload)
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "gxshell_execute_command", Arguments: map[string]any{"server": "private", "command": "whoami", "requestId": requestID}})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &payload); err != nil {
		t.Fatal(err)
	}
	if !result.IsError || payload["errorKind"] != "request_id_conflict" {
		t.Fatalf("changed retry accepted: %#v", payload)
	}
	// Without a native authorization context, a critical command must fail
	// closed even though the profile has explicitly opted in.
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "gxshell_execute_command", Arguments: map[string]any{"server": "prod", "command": "rm -rf /"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &payload); err != nil {
		t.Fatal(err)
	}
	if !result.IsError || payload["riskTier"] != "T3" || (payload["outcome"] != "blocked" && payload["errorKind"] != "confirmation") {
		t.Fatalf("critical command bypassed approval: %#v", payload)
	}
	// MCP uses the same full-trust boundary and structured self-destruction
	// block as CLI commands, including complete scripts sent over stdin.
	if err := store.SaveProfiles([]types.Profile{{ID: "allowed", CliEnabled: true, CliAlias: "prod", CliTrustMode: "full", CliTrustUntil: time.Now().Add(time.Hour)}}); err != nil {
		t.Fatal(err)
	}
	app.cliConfirmRiskFn = func(string, string, riskAssessment, approvalStrength) (bool, error) {
		t.Error("full-trust self-destruction opened an MCP approval")
		return false, nil
	}
	result, err = session.CallTool(ctx, &mcp.CallToolParams{Name: "gxshell_execute_script", Arguments: map[string]any{"server": "prod", "script": "echo starting\nrm -rf /\n", "shell": "bash"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(result.Content[0].(*mcp.TextContent).Text), &payload); err != nil {
		t.Fatal(err)
	}
	if !result.IsError || payload["blockedBy"] != "self-destructive" || payload["approval"] != cliApprovalSelfDestructiveBlock || payload["outcome"] != "blocked" {
		t.Fatalf("MCP full-trust self-destruction bypassed CLI policy: %#v", payload)
	}
}

func TestMCPHTTPRequiresAuthAndRejectsCrossOriginAndRebinding(t *testing.T) {
	host := httptest.NewServer(NewApp().newCliHandler("test-token"))
	defer host.Close()
	for _, tc := range []struct {
		token, origin, host string
		want                int
	}{
		{"", "", "", http.StatusUnauthorized},
		{"wrong", "", "", http.StatusUnauthorized},
		{"test-token", "https://untrusted.example", "", http.StatusForbidden},
		{"test-token", "", "untrusted.example", http.StatusForbidden},
	} {
		req, err := http.NewRequest("POST", host.URL+"/mcp", bytes.NewBufferString(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		if tc.token != "" {
			req.Header.Set("Authorization", "Bearer "+tc.token)
		}
		if tc.origin != "" {
			req.Header.Set("Origin", tc.origin)
		}
		if tc.host != "" {
			req.Host = tc.host
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Fatalf("status = %d, want %d", resp.StatusCode, tc.want)
		}
	}
}

func TestMCPHTTPAcceptsOlderProtocolInitialization(t *testing.T) {
	host := httptest.NewServer(NewApp().newCliHandler("test-token"))
	defer host.Close()
	for _, version := range []string{"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"} {
		body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{
			"protocolVersion": version, "capabilities": map[string]any{}, "clientInfo": map[string]any{"name": "compat-test", "version": "1"},
		}})
		req, _ := http.NewRequest("POST", host.URL+"/mcp", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Authorization", "Bearer test-token")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		var payload struct {
			Result struct {
				ProtocolVersion string `json:"protocolVersion"`
			} `json:"result"`
		}
		err = json.NewDecoder(resp.Body).Decode(&payload)
		resp.Body.Close()
		if err != nil || resp.StatusCode != http.StatusOK || payload.Result.ProtocolVersion != version {
			t.Fatalf("protocol %s: status=%d result=%#v error=%v", version, resp.StatusCode, payload, err)
		}
	}
}
