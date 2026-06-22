package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	daemonURL        = "http://127.0.0.1:56789"
	cliTokenFilename = "cli_token"
	version          = "1.1.3"
	cliMinTimeout    = time.Second
	cliMaxTimeout    = 30 * time.Minute
)

var httpClient = &http.Client{Timeout: 31 * time.Minute}

type cliOptions struct {
	json    bool
	timeout time.Duration
}

func main() {
	args, opts, err := parseLeadingFlags(os.Args[1:], cliOptions{})
	if err != nil {
		fatalErrorKind(opts, 1, "validation", err.Error())
	}
	if len(args) < 1 {
		showHelp()
		return
	}

	switch args[0] {
	case "exec":
		server, command, nextOpts, err := parseExecArgs(args[1:], opts)
		if err != nil {
			if nextOpts.json {
				fatalErrorKind(nextOpts, 1, "validation", err.Error())
			}
			fmt.Println("Error:", err)
			fmt.Println("Usage: gxshell-cli exec <server> \"<command>\"")
			os.Exit(1)
		}
		execCommand(server, command, nextOpts)
	case "exec-file":
		server, filePath, nextOpts, err := parseTwoArgCommand(args[1:], opts, "exec-file")
		if err != nil {
			fatalErrorKind(nextOpts, 1, "validation", err.Error())
		}
		data, err := os.ReadFile(filePath)
		if err != nil {
			fatalError(nextOpts, 1, "failed to read script file: "+err.Error())
		}
		execCommand(server, normalizeScriptInput(data), nextOpts)
	case "exec-stdin":
		server, nextOpts, err := parseOneArgCommand(args[1:], opts, "exec-stdin")
		if err != nil {
			fatalErrorKind(nextOpts, 1, "validation", err.Error())
		}
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			fatalError(nextOpts, 1, "failed to read stdin: "+err.Error())
		}
		execCommand(server, normalizeScriptInput(data), nextOpts)
	case "list":
		nextOpts, err := parseNoArgCommand(args[1:], opts, "list")
		if err != nil {
			fatalErrorKind(nextOpts, 1, "validation", err.Error())
		}
		listServers(nextOpts)
	case "status":
		nextOpts, err := parseNoArgCommand(args[1:], opts, "status")
		if err != nil {
			fatalErrorKind(nextOpts, 1, "validation", err.Error())
		}
		showStatus(nextOpts)
	case "ping":
		nextOpts, err := parseNoArgCommand(args[1:], opts, "ping")
		if err != nil {
			fatalErrorKind(nextOpts, 1, "validation", err.Error())
		}
		checkDaemon(nextOpts)
	case "help", "--help", "-h":
		showHelp()
	case "version", "--version", "-v":
		fmt.Printf("gxshell-cli version %s\n", version)
	default:
		if opts.json {
			fatalErrorKind(opts, 1, "validation", fmt.Sprintf("unknown command: %s", args[0]))
		}
		fmt.Printf("Unknown command: %s\n\n", args[0])
		showHelp()
		os.Exit(1)
	}
}

func execCommand(server, command string, opts cliOptions) {
	if strings.TrimSpace(server) == "" || strings.TrimSpace(command) == "" {
		fatalErrorKind(opts, 1, "validation", "server and command are required")
	}
	payload := map[string]any{
		"server":  server,
		"command": command,
	}
	if opts.timeout > 0 {
		payload["timeoutMs"] = int(opts.timeout / time.Millisecond)
	}
	result := requestJSON("POST", "/cli/exec", payload, opts)
	normalizeExecResult(result)
	if opts.json {
		printJSON(result)
	}

	if blocked, ok := result["blocked"].(bool); ok && blocked {
		if !opts.json {
			fmt.Println("BLOCKED:", stringField(result, "error"))
			if reason := stringField(result, "reason"); reason != "" {
				fmt.Println("Reason:", reason)
			}
		}
		os.Exit(2)
	}

	if output := displayOutput(result); output != "" && !opts.json {
		fmt.Print(output)
	}
	if timedOut, _ := boolField(result, "timedOut"); timedOut {
		os.Exit(124)
	}
	if exitCode, ok := intField(result, "exitCode"); ok && exitCode != 0 {
		os.Exit(normalizeExitCode(exitCode))
	}

	if errMsg := stringField(result, "error"); errMsg != "" {
		if !opts.json {
			fmt.Println("Error:", errMsg)
			if output := displayOutput(result); output != "" {
				fmt.Println("\nPartial output:")
				fmt.Print(output)
			}
		}
		os.Exit(1)
	}
}

func listServers(opts cliOptions) {
	result := requestJSON("GET", "/cli/list", nil, opts)
	if opts.json {
		printJSON(result)
		return
	}
	if errMsg := stringField(result, "error"); errMsg != "" {
		fmt.Println("Error:", errMsg)
		os.Exit(1)
	}

	servers, ok := result["servers"].([]any)
	if !ok || len(servers) == 0 {
		fmt.Println("No CLI-enabled servers configured.")
		fmt.Println("Enable CLI access on a server profile in gxShell first.")
		return
	}

	fmt.Printf("Available servers (%d):\n\n", len(servers))
	for _, item := range servers {
		server, ok := item.(map[string]any)
		if !ok {
			continue
		}
		fmt.Printf("  - %s\n", stringField(server, "name"))
	}
}

func showStatus(opts cliOptions) {
	result := requestJSON("GET", "/cli/status", nil, opts)
	if opts.json {
		printJSON(result)
		return
	}
	if errMsg := stringField(result, "error"); errMsg != "" {
		fmt.Println("Error:", errMsg)
		os.Exit(1)
	}

	active, ok := result["active"].([]any)
	if !ok || len(active) == 0 {
		fmt.Println("No active CLI SSH connections.")
		return
	}

	fmt.Printf("Active CLI SSH connections (%d):\n\n", len(active))
	for _, item := range active {
		session, ok := item.(map[string]any)
		if !ok {
			continue
		}
		fmt.Printf("  - %s (%s)\n", stringField(session, "name"), stringField(session, "state"))
	}
}

func checkDaemon(opts cliOptions) {
	resp, err := httpClient.Get(daemonURL + "/cli/ping")
	if err != nil {
		fatalError(opts, 1, "gxShell daemon is not running")
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fatalError(opts, 1, "gxShell daemon returned: "+resp.Status)
	}
	if opts.json {
		var result map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			fatalError(opts, 1, "failed to parse response: "+err.Error())
		}
		printJSON(result)
		return
	}
	fmt.Println("gxShell daemon is running")
}

func requestJSON(method, path string, payload any, opts cliOptions) map[string]any {
	token, err := loadToken()
	if err != nil {
		fatalError(opts, 1, err.Error()+". Start gxShell once so it can create the local CLI token.")
	}

	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			fatalError(opts, 1, "failed to encode request: "+err.Error())
		}
		body = bytes.NewReader(raw)
	}

	req, err := http.NewRequest(method, daemonURL+path, body)
	if err != nil {
		fatalError(opts, 1, "failed to create request: "+err.Error())
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		fatalError(opts, 1, "Cannot connect to gxShell. Please start the gxShell GUI application first.")
	}
	defer resp.Body.Close()

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		fatalError(opts, 1, "failed to parse response: "+err.Error())
	}
	if resp.StatusCode == http.StatusUnauthorized {
		fatalError(opts, 1, "unauthorized CLI request. Restart gxShell and rebuild or rerun this CLI from the same user account.")
	}
	return result
}

func parseLeadingFlags(args []string, opts cliOptions) ([]string, cliOptions, error) {
	for len(args) > 0 {
		switch args[0] {
		case "--json":
			opts.json = true
			args = args[1:]
		case "--timeout":
			if len(args) < 2 {
				return args, opts, fmt.Errorf("--timeout requires a value")
			}
			timeout, err := parseTimeout(args[1])
			if err != nil {
				return args, opts, err
			}
			opts.timeout = timeout
			args = args[2:]
		default:
			return args, opts, nil
		}
	}
	return args, opts, nil
}

func parseExecArgs(args []string, opts cliOptions) (string, string, cliOptions, error) {
	args, opts, err := parseLeadingFlags(args, opts)
	if err != nil {
		return "", "", opts, err
	}
	if len(args) < 2 {
		return "", "", opts, fmt.Errorf("exec requires <server> and <command>")
	}
	server := args[0]
	parts := append([]string(nil), args[1:]...)
	parts, opts, err = stripTrailingFlags(parts, opts)
	if err != nil {
		return "", "", opts, err
	}
	command := strings.TrimSpace(strings.Join(parts, " "))
	if server == "" || command == "" {
		return "", "", opts, fmt.Errorf("exec requires <server> and <command>")
	}
	return server, command, opts, nil
}

func parseTwoArgCommand(args []string, opts cliOptions, name string) (string, string, cliOptions, error) {
	args, opts, err := parseLeadingFlags(args, opts)
	if err != nil {
		return "", "", opts, err
	}
	args, opts, err = stripTrailingFlags(args, opts)
	if err != nil {
		return "", "", opts, err
	}
	if len(args) != 2 {
		return "", "", opts, fmt.Errorf("%s requires <server> and <file>", name)
	}
	return args[0], args[1], opts, nil
}

func parseOneArgCommand(args []string, opts cliOptions, name string) (string, cliOptions, error) {
	args, opts, err := parseLeadingFlags(args, opts)
	if err != nil {
		return "", opts, err
	}
	args, opts, err = stripTrailingFlags(args, opts)
	if err != nil {
		return "", opts, err
	}
	if len(args) != 1 {
		return "", opts, fmt.Errorf("%s requires <server>", name)
	}
	return args[0], opts, nil
}

func parseNoArgCommand(args []string, opts cliOptions, name string) (cliOptions, error) {
	args, opts, err := parseLeadingFlags(args, opts)
	if err != nil {
		return opts, err
	}
	if len(args) != 0 {
		return opts, fmt.Errorf("%s does not take positional arguments", name)
	}
	return opts, nil
}

func stripTrailingFlags(args []string, opts cliOptions) ([]string, cliOptions, error) {
	out := append([]string(nil), args...)
	for len(out) > 0 {
		last := out[len(out)-1]
		if last == "--json" {
			opts.json = true
			out = out[:len(out)-1]
			continue
		}
		if len(out) >= 2 && out[len(out)-2] == "--timeout" {
			timeout, err := parseTimeout(out[len(out)-1])
			if err != nil {
				return args, opts, err
			}
			opts.timeout = timeout
			out = out[:len(out)-2]
			continue
		}
		break
	}
	return out, opts, nil
}

func parseTimeout(value string) (time.Duration, error) {
	if secs, err := strconv.Atoi(value); err == nil {
		return validateTimeout(time.Duration(secs) * time.Second)
	}
	timeout, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("invalid timeout %q (use seconds, 30s, 2m, etc.)", value)
	}
	return validateTimeout(timeout)
}

func validateTimeout(timeout time.Duration) (time.Duration, error) {
	if timeout < cliMinTimeout {
		return 0, fmt.Errorf("timeout must be at least 1 second")
	}
	if timeout > cliMaxTimeout {
		return 0, fmt.Errorf("timeout must be 30 minutes or less")
	}
	return timeout, nil
}

func printJSON(value any) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(value)
}

func fatalError(opts cliOptions, code int, message string) {
	fatalErrorKind(opts, code, "cli", message)
}

func fatalErrorKind(opts cliOptions, code int, kind string, message string) {
	if opts.json {
		printJSON(map[string]any{"error": message, "errorKind": kind})
	} else {
		fmt.Println("Error:", message)
	}
	os.Exit(code)
}

func normalizeScriptInput(data []byte) string {
	data = bytes.TrimPrefix(data, []byte{0xef, 0xbb, 0xbf})
	text := string(data)
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	return text
}

func normalizeExecResult(result map[string]any) {
	output := stringField(result, "output")
	if output == "" {
		return
	}
	lines := strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n")
	kept := lines[:0]
	var summaries []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if isSyntheticOutputLine(trimmed, result) {
			summaries = append(summaries, trimmed)
			continue
		}
		kept = append(kept, line)
	}
	if len(summaries) == 0 {
		return
	}
	cleaned := strings.TrimRight(strings.Join(kept, "\n"), "\n")
	result["output"] = cleaned
	result["summary"] = appendLine(stringField(result, "summary"), strings.Join(summaries, "\n"))
	result["displayOutput"] = appendLine(cleaned, stringField(result, "summary"))
}

func isSyntheticOutputLine(line string, result map[string]any) bool {
	if line == "" {
		return false
	}
	if strings.HasPrefix(line, "(exit code: ") && strings.HasSuffix(line, ")") {
		return true
	}
	if strings.HasPrefix(line, "(output truncated after ") && strings.HasSuffix(line, " bytes)") {
		return true
	}
	if errMsg := stringField(result, "error"); errMsg != "" && line == "error: "+errMsg {
		return true
	}
	return false
}

func loadToken() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(filepath.Join(base, "gxShell", cliTokenFilename))
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return "", fmt.Errorf("CLI token file is empty")
	}
	return token, nil
}

func stringField(m map[string]any, key string) string {
	if value, ok := m[key].(string); ok {
		return value
	}
	return ""
}

func boolField(m map[string]any, key string) (bool, bool) {
	if value, ok := m[key].(bool); ok {
		return value, true
	}
	return false, false
}

func displayOutput(m map[string]any) string {
	if value := stringField(m, "displayOutput"); value != "" {
		return value
	}
	if value := stringField(m, "output"); value != "" {
		return appendLine(value, stringField(m, "summary"))
	}
	return stringField(m, "summary")
}

func appendLine(base string, line string) string {
	if line == "" {
		return base
	}
	if base == "" {
		return line
	}
	return strings.TrimRight(base, "\n") + "\n" + line
}

func intField(m map[string]any, key string) (int, bool) {
	switch value := m[key].(type) {
	case float64:
		return int(value), true
	case int:
		return value, true
	default:
		return 0, false
	}
}

func normalizeExitCode(code int) int {
	if code <= 0 {
		return 1
	}
	if code > 255 {
		return 1
	}
	return code
}

func showHelp() {
	help := `gxshell-cli - Command-line interface for gxShell

USAGE:
  gxshell-cli <command> [arguments]

COMMANDS:
  exec <server> "<command>"    Execute a command on a CLI-enabled server
  exec-file <server> <file>     Execute a local script file on a server
  exec-stdin <server>           Execute a script read from stdin
  list                         List CLI-enabled server aliases
  status                       Show active CLI SSH connections
  ping                         Check if gxShell is running
  help                         Show this help message
  version                      Show version information

SECURITY:
  - The gxShell GUI must be running.
  - Requests require a local token generated by gxShell.
  - Server profiles are hidden unless CLI access is enabled.
  - The CLI lists aliases only, not IP addresses or usernames.
  - Simple read-only commands run without a prompt; other commands ask for native confirmation and may be batched.

OPTIONS:
  --json                       Print machine-readable JSON
  --timeout <duration>          Remote command timeout, e.g. 60, 90s, 5m
`
	fmt.Print(help)
}
