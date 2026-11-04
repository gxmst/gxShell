package mcpserver

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	appversion "gxShell/backend/version"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const Instructions = "Use server aliases from gxshell_list_servers. gxShell must be running with CLI / MCP access enabled, and each server must opt in. Use gxshell_execute_script with an explicit shell for multiline scripts or heredocs. Inspect outcome, exitCode, blocked, timedOut and remoteState. Keep requestId for retries; never blindly repeat an action after a timeout or cancellation. Native approvals and expiring trust apply to every transport. Use secret:// references only; never send credential values."

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)
var heredocPattern = regexp.MustCompile(`(?:^|[;&|]\s*|\s)<<-?\s*["']?[A-Za-z_][A-Za-z0-9_]*["']?`)
var secretEnvPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
var secretRefPattern = regexp.MustCompile(`^secret://[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type execOptions struct {
	Server    string            `json:"server" jsonschema:"Server alias returned by gxshell_list_servers"`
	TimeoutMs int               `json:"timeoutMs,omitempty" jsonschema:"Remote timeout in milliseconds; default 120000; range 1000 to 1800000"`
	Async     bool              `json:"async,omitempty" jsonschema:"Return a jobId immediately; inspect it with the job tools; incompatible with secrets"`
	RequestID string            `json:"requestId,omitempty" jsonschema:"Only for retrying the same unchanged request; otherwise omit to generate a new ID"`
	Secrets   map[string]string `json:"secrets,omitempty" jsonschema:"Environment variable names mapped to secret://alias references; synchronous execution only; never credential values"`
}

type commandArgs struct {
	execOptions
	Command string `json:"command" jsonschema:"Single shell command without newlines or heredocs; use execute_script for those"`
}

type scriptArgs struct {
	execOptions
	Script string `json:"script" jsonschema:"Complete script text sent over SSH stdin, including any newlines or heredocs"`
	Shell  string `json:"shell" jsonschema:"Explicit script interpreter: sh, bash, dash, zsh, or ksh"`
}

type jobArgs struct {
	JobID string `json:"jobId" jsonschema:"Job ID returned by asynchronous execution"`
}

type logsArgs struct {
	JobID string `json:"jobId" jsonschema:"Job ID returned by asynchronous execution"`
	After int64  `json:"after,omitempty" jsonschema:"Return only events after this sequence; use nextSequence from the previous result"`
}

// New creates the same tool catalog for HTTP and stdio transports. Execution
// always passes through Caller; the MCP layer never opens an SSH session.
func New(call Caller) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "gxShell", Version: appversion.Version}, &mcp.ServerOptions{Instructions: Instructions})
	readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true}
	mcp.AddTool(server, &mcp.Tool{Name: "gxshell_list_servers", Description: "List explicitly authorized server aliases. Does not expose SSH credentials, host addresses or usernames.", Annotations: readOnly},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
			return invoke(ctx, call, http.MethodGet, "/cli/list", nil, "")
		})
	mcp.AddTool(server, &mcp.Tool{Name: "gxshell_connection_status", Description: "List active SSH connections for authorized server aliases.", Annotations: readOnly},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, any, error) {
			return invoke(ctx, call, http.MethodGet, "/cli/status", nil, "")
		})
	mcp.AddTool(server, &mcp.Tool{Name: "gxshell_execute_command", Description: "Execute one remote shell command through gxShell's native approval policy. Returns structured outcome, output and requestId. Use execute_script for multiline input. Long operations can use async and the job tools."},
		func(ctx context.Context, _ *mcp.CallToolRequest, args commandArgs) (*mcp.CallToolResult, any, error) {
			if strings.TrimSpace(args.Command) == "" {
				return validation("command is required")
			}
			if strings.ContainsAny(args.Command, "\r\n") || heredocPattern.MatchString(args.Command) {
				return validation("multiline commands and heredocs must use gxshell_execute_script with an explicit shell")
			}
			return execute(ctx, call, args.execOptions, map[string]any{"command": strings.TrimSpace(args.Command)})
		})
	mcp.AddTool(server, &mcp.Tool{Name: "gxshell_execute_script", Description: "Execute complete multiline script text over SSH stdin with an explicit interpreter. Uses the same native approval, timeout and request protection as execute_command. Scripts are arbitrary code, not a sandbox."},
		func(ctx context.Context, _ *mcp.CallToolRequest, args scriptArgs) (*mcp.CallToolResult, any, error) {
			if strings.TrimSpace(args.Script) == "" {
				return validation("script is required")
			}
			switch args.Shell {
			case "sh", "bash", "dash", "zsh", "ksh":
			default:
				return validation("shell must be sh, bash, dash, zsh, or ksh")
			}
			script := strings.TrimPrefix(args.Script, "\ufeff")
			script = strings.ReplaceAll(strings.ReplaceAll(script, "\r\n", "\n"), "\r", "\n")
			return execute(ctx, call, args.execOptions, map[string]any{"script": script, "shell": args.Shell})
		})
	mcp.AddTool(server, &mcp.Tool{Name: "gxshell_job_status", Description: "Get a background job snapshot without historical output events. Cancellation acknowledgement does not prove remote termination; inspect remoteState.", Annotations: readOnly},
		func(ctx context.Context, _ *mcp.CallToolRequest, args jobArgs) (*mcp.CallToolResult, any, error) {
			return job(ctx, call, http.MethodGet, args.JobID, "&after=9223372036854775807")
		})
	mcp.AddTool(server, &mcp.Tool{Name: "gxshell_job_logs", Description: "Poll ordered stdout/stderr events and job state. Pass the previous nextSequence as after to avoid repeating output.", Annotations: readOnly},
		func(ctx context.Context, _ *mcp.CallToolRequest, args logsArgs) (*mcp.CallToolResult, any, error) {
			if args.After < 0 {
				return validation("after must be non-negative")
			}
			return job(ctx, call, http.MethodGet, args.JobID, "&after="+strconv.FormatInt(args.After, 10))
		})
	mcp.AddTool(server, &mcp.Tool{Name: "gxshell_cancel_job", Description: "Request cancellation of a background job. Check cancelRequested and remoteState; remote processes or detached children may still be running."},
		func(ctx context.Context, _ *mcp.CallToolRequest, args jobArgs) (*mcp.CallToolResult, any, error) {
			return job(ctx, call, http.MethodDelete, args.JobID, "")
		})
	return server
}

// HTTPHandler serves Streamable HTTP at a single endpoint. Stateless JSON
// responses work with both current clients and older MCP protocol revisions.
// Job polling supplies incremental output without persistent SSE connections.
func HTTPHandler(call Caller) http.Handler {
	server := New(call)
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{
		Stateless: true, JSONResponse: true, MaxRequestBodyBytes: MaxRequestBytes,
		PropagateRequestCancellation: true,
	})
	return http.NewCrossOriginProtection().Handler(handler)
}

func execute(ctx context.Context, call Caller, opts execOptions, payload map[string]any) (*mcp.CallToolResult, any, error) {
	if strings.TrimSpace(opts.Server) == "" {
		return validation("server alias is required")
	}
	if opts.TimeoutMs != 0 && (opts.TimeoutMs < 1000 || opts.TimeoutMs > 1800000) {
		return validation("timeoutMs must be between 1000 and 1800000")
	}
	if opts.Async && len(opts.Secrets) > 0 {
		return validation("named secrets require synchronous execution")
	}
	for name, ref := range opts.Secrets {
		if !secretEnvPattern.MatchString(name) || !secretRefPattern.MatchString(ref) {
			return validation("secrets must map valid environment names to secret://alias references")
		}
	}
	id := opts.RequestID
	if id != "" {
		if !requestIDPattern.MatchString(id) {
			return validation("requestId must contain 1-96 letters, digits, underscores or hyphens")
		}
		caps, err := call(ctx, http.MethodGet, "/cli/ping", nil, "")
		if err != nil || caps["execRequestDeduplication"] != "process-30m-v1" {
			return validation("this gxShell instance does not support protected retries; no execution request was sent")
		}
	} else {
		var raw [16]byte
		if _, err := rand.Read(raw[:]); err != nil {
			return nil, nil, err
		}
		id = hex.EncodeToString(raw[:])
	}
	payload["server"] = strings.TrimSpace(opts.Server)
	if opts.TimeoutMs != 0 {
		payload["timeoutMs"] = opts.TimeoutMs
	}
	if opts.Async {
		payload["async"] = true
	}
	if len(opts.Secrets) > 0 {
		payload["secrets"] = opts.Secrets
	}
	return invoke(ctx, call, http.MethodPost, "/cli/exec", payload, id)
}

func job(ctx context.Context, call Caller, method, id, query string) (*mcp.CallToolResult, any, error) {
	if strings.TrimSpace(id) == "" {
		return validation("jobId is required")
	}
	return invoke(ctx, call, method, "/cli/jobs?id="+url.QueryEscape(id)+query, nil, "")
}

func validation(message string) (*mcp.CallToolResult, any, error) {
	return &mcp.CallToolResult{IsError: true}, map[string]any{
		"error": message, "errorKind": "validation", "outcome": "validation_error", "blocked": false,
	}, nil
}

func invoke(ctx context.Context, call Caller, method, path string, payload any, id string) (*mcp.CallToolResult, any, error) {
	result, err := call(ctx, method, path, payload, id)
	if err != nil {
		result = map[string]any{"error": err.Error(), "errorKind": "client", "outcome": "client_error", "blocked": false}
		if id != "" {
			result["requestId"] = id
			result["remoteState"] = "unknown"
		}
	}
	if result == nil {
		return nil, nil, fmt.Errorf("gxShell returned no result")
	}
	failed := result["blocked"] == true || result["timedOut"] == true
	if message, ok := result["error"].(string); ok && message != "" {
		failed = true
	}
	switch result["outcome"] {
	case "remote_failed", "blocked", "timeout", "validation_error", "client_error":
		failed = true
	}
	return &mcp.CallToolResult{IsError: failed}, result, nil
}
