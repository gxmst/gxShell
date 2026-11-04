package mcpserver

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func connectTestClient(t *testing.T, call Caller, httpMode bool) (*mcp.ClientSession, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	var transport mcp.Transport
	if httpMode {
		host := httptest.NewServer(HTTPHandler(call))
		t.Cleanup(host.Close)
		transport = &mcp.StreamableClientTransport{Endpoint: host.URL}
	} else {
		clientTransport, serverTransport := mcp.NewInMemoryTransports()
		session, err := New(call).Connect(ctx, serverTransport, nil)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = session.Close() })
		transport = clientTransport
	}
	client := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "1"}, nil)
	session, err := client.Connect(ctx, transport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session, ctx
}

func toolPayload(t *testing.T, session *mcp.ClientSession, ctx context.Context, name string, args map[string]any) (*mcp.CallToolResult, map[string]any) {
	t.Helper()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Content) != 1 {
		t.Fatalf("content = %#v", result.Content)
	}
	text, ok := result.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("content = %T", result.Content[0])
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(text.Text), &payload); err != nil {
		t.Fatal(err)
	}
	if result.StructuredContent == nil {
		t.Fatal("missing structuredContent")
	}
	return result, payload
}

func TestTransportsShareToolsAndExecutionContract(t *testing.T) {
	for _, httpMode := range []bool{false, true} {
		t.Run(map[bool]string{false: "stdio-protocol", true: "http"}[httpMode], func(t *testing.T) {
			var ids []string
			call := func(_ context.Context, method, path string, body any, id string) (map[string]any, error) {
				if path == "/cli/list" {
					return map[string]any{"servers": []any{map[string]any{"name": "prod"}}, "count": 1}, nil
				}
				if path == "/cli/ping" {
					return map[string]any{"execRequestDeduplication": "process-30m-v1"}, nil
				}
				if method != "POST" || path != "/cli/exec" {
					t.Fatalf("unexpected dispatch: %s %s", method, path)
				}
				payload := body.(map[string]any)
				if payload["server"] != "prod" || payload["script"] != "cat <<'EOF'\nhello\nEOF\n" || payload["shell"] != "bash" || payload["timeoutMs"] != 10000 {
					t.Fatalf("execution payload = %#v", payload)
				}
				if id == "" {
					t.Fatal("missing request ID")
				}
				ids = append(ids, id)
				return map[string]any{"outcome": "succeeded", "exitCode": 0, "stdout": "hello\n", "requestId": id, "riskTier": "T1", "approval": "user"}, nil
			}
			session, ctx := connectTestClient(t, call, httpMode)
			tools, err := session.ListTools(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			if len(tools.Tools) != 7 {
				t.Fatalf("tools = %d", len(tools.Tools))
			}
			for _, tool := range tools.Tools {
				if tool.InputSchema == nil {
					t.Fatalf("missing schema for %s", tool.Name)
				}
				if strings.Contains(tool.Name, "execute") && tool.Annotations != nil && tool.Annotations.ReadOnlyHint {
					t.Fatal("arbitrary execution marked read-only")
				}
			}
			if !strings.Contains(session.InitializeResult().Instructions, "requestId") {
				t.Fatal("missing agent guidance")
			}
			result, payload := toolPayload(t, session, ctx, "gxshell_list_servers", map[string]any{})
			if result.IsError || payload["count"] != float64(1) {
				t.Fatalf("list = %#v", payload)
			}
			args := map[string]any{"server": "prod", "script": "\ufeffcat <<'EOF'\r\nhello\r\nEOF\r\n", "shell": "bash", "timeoutMs": 10000}
			for i := 0; i < 2; i++ {
				result, payload = toolPayload(t, session, ctx, "gxshell_execute_script", args)
				if result.IsError || payload["outcome"] != "succeeded" || payload["approval"] != "user" {
					t.Fatalf("execution = %#v", payload)
				}
			}
			if ids[0] == ids[1] {
				t.Fatal("independent calls reused a request ID")
			}
			args["requestId"] = ids[0]
			toolPayload(t, session, ctx, "gxshell_execute_script", args)
			if ids[2] != ids[0] {
				t.Fatal("retry did not preserve ID")
			}
		})
	}
}

func TestValidationNeverDispatchesExecution(t *testing.T) {
	calls := 0
	session, ctx := connectTestClient(t, func(context.Context, string, string, any, string) (map[string]any, error) {
		calls++
		return map[string]any{}, nil
	}, false)
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"gxshell_execute_command", map[string]any{"server": "prod", "command": "cat <<EOF"}},
		{"gxshell_execute_command", map[string]any{"server": "prod", "command": "uptime\nwhoami"}},
		{"gxshell_execute_command", map[string]any{"server": "prod", "command": "uptime", "timeoutMs": 500}},
		{"gxshell_execute_command", map[string]any{"server": "prod", "command": "uptime", "requestId": "bad/id"}},
		{"gxshell_execute_command", map[string]any{"server": "prod", "command": "uptime", "secrets": map[string]string{"KEY": "plaintext"}}},
		{"gxshell_execute_command", map[string]any{"server": "prod", "command": "uptime", "async": true, "secrets": map[string]string{"KEY": "secret://key"}}},
		{"gxshell_execute_script", map[string]any{"server": "prod", "script": "uptime", "shell": "powershell"}},
		{"gxshell_job_logs", map[string]any{"jobId": "job-1", "after": -1}},
	} {
		result, payload := toolPayload(t, session, ctx, tc.name, tc.args)
		if !result.IsError || payload["outcome"] != "validation_error" {
			t.Fatalf("validation = %#v", payload)
		}
	}
	if calls != 0 {
		t.Fatalf("invalid calls reached API: %d", calls)
	}
}

func TestToolFailuresRemainStructured(t *testing.T) {
	for _, outcome := range []string{"remote_failed", "blocked", "timeout", "validation_error"} {
		t.Run(outcome, func(t *testing.T) {
			original := map[string]any{"outcome": outcome, "exitCode": 7, "blocked": outcome == "blocked", "remoteState": "unknown", "riskTier": "T3"}
			session, ctx := connectTestClient(t, func(context.Context, string, string, any, string) (map[string]any, error) { return original, nil }, false)
			result, payload := toolPayload(t, session, ctx, "gxshell_execute_command", map[string]any{"server": "prod", "command": "uptime"})
			if !result.IsError || payload["outcome"] != outcome || payload["riskTier"] != "T3" || payload["remoteState"] != "unknown" {
				t.Fatalf("failure = %#v", payload)
			}
		})
	}
}

func TestJobsDispatchCorrectMethodsAndSequence(t *testing.T) {
	var requests []string
	session, ctx := connectTestClient(t, func(_ context.Context, method, path string, _ any, _ string) (map[string]any, error) {
		requests = append(requests, method+" "+path)
		return map[string]any{"state": "running", "nextSequence": 12}, nil
	}, true)
	toolPayload(t, session, ctx, "gxshell_job_status", map[string]any{"jobId": "job-1"})
	toolPayload(t, session, ctx, "gxshell_job_logs", map[string]any{"jobId": "job-1", "after": 12})
	toolPayload(t, session, ctx, "gxshell_cancel_job", map[string]any{"jobId": "job-1"})
	want := []string{"GET /cli/jobs?id=job-1&after=9223372036854775807", "GET /cli/jobs?id=job-1&after=12", "DELETE /cli/jobs?id=job-1"}
	if !reflect.DeepEqual(requests, want) {
		t.Fatalf("requests = %#v", requests)
	}
}
