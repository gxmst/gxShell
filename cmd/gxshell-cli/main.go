package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	daemonURL        = "http://127.0.0.1:56789"
	cliTokenFilename = "cli_token"
	version          = "1.4.0"
	cliMinTimeout    = time.Second
	cliMaxTimeout    = 30 * time.Minute
)

var httpClient = &http.Client{Timeout: 31 * time.Minute}

type cliOptions struct {
	json    bool
	timeout time.Duration
	shell   string
	follow  bool
	detach  bool
	secrets map[string]string
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
		execScript(server, normalizeScriptInput(data), nextOpts)
	case "exec-stdin":
		server, nextOpts, err := parseOneArgCommand(args[1:], opts, "exec-stdin")
		if err != nil {
			fatalErrorKind(nextOpts, 1, "validation", err.Error())
		}
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			fatalError(nextOpts, 1, "failed to read stdin: "+err.Error())
		}
		execScript(server, normalizeScriptInput(data), nextOpts)
	case "copy":
		source, destination, nextOpts, err := parseTwoArgCommand(args[1:], opts, "copy")
		if err != nil {
			fatalErrorKind(nextOpts, 1, "validation", err.Error())
		}
		copyRemote(source, destination, nextOpts)
	case "secret":
		handleSecretCommand(args[1:], opts)
	case "job":
		handleJobCommand(args[1:], opts)
	case "tunnel":
		handleTunnelCommand(args[1:], opts)
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
	case "doctor":
		nextOpts, err := parseNoArgCommand(args[1:], opts, "doctor")
		if err != nil {
			fatalErrorKind(nextOpts, 1, "validation", err.Error())
		}
		showDoctor(nextOpts)
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
	if opts.shell != "" {
		fatalErrorKind(opts, 1, "validation", "--shell is only valid with exec-file or exec-stdin")
	}
	if requiresScriptInput(command) {
		fatalScriptInput(opts, server)
	}
	execRequest(server, command, "", opts)
}

func execScript(server, script string, opts cliOptions) {
	if strings.TrimSpace(server) == "" || strings.TrimSpace(script) == "" {
		fatalErrorKind(opts, 1, "validation", "server and script are required")
	}
	if !isAllowedShell(opts.shell) {
		fatalErrorKind(opts, 1, "validation", "--shell is required and must be one of: sh, bash, dash, zsh, ksh")
	}
	execRequest(server, "", script, opts)
}

func execRequest(server, command, script string, opts cliOptions) {
	if opts.follow && opts.detach {
		fatalErrorKind(opts, 1, "validation", "--follow and --detach cannot be used together")
	}
	payload := map[string]any{
		"server": server,
	}
	if script != "" {
		payload["script"] = script
		payload["shell"] = opts.shell
	} else {
		payload["command"] = command
	}
	if opts.follow || opts.detach {
		payload["async"] = true
	}
	if opts.timeout > 0 {
		payload["timeoutMs"] = int(opts.timeout / time.Millisecond)
	}
	if len(opts.secrets) > 0 {
		payload["secrets"] = opts.secrets
	}
	result := requestJSON("POST", "/cli/exec", payload, opts)
	if opts.follow || opts.detach {
		if errMsg := stringField(result, "error"); errMsg != "" {
			fatalErrorKind(opts, 1, stringField(result, "errorKind"), errMsg)
		}
		jobID := stringField(result, "jobId")
		if jobID == "" {
			fatalError(opts, 1, "daemon did not return a job id")
		}
		if opts.detach {
			if opts.json {
				printJSON(result)
			} else {
				fmt.Println(jobID)
			}
			return
		}
		followJob(jobID, opts, true)
		return
	}
	normalizeExecResult(result)
	if opts.json {
		printJSON(result)
	}

	if blocked, ok := result["blocked"].(bool); ok && blocked {
		if !opts.json {
			message := blockedMessage(result)
			if message == "" {
				message = "command blocked"
			}
			fmt.Println("BLOCKED:", message)
			if detail := stringField(result, "detail"); detail != "" {
				fmt.Println("Detail:", detail)
			}
			if blockedBy := stringField(result, "blockedBy"); blockedBy != "" {
				fmt.Println("Blocked by:", blockedBy)
			}
		}
		os.Exit(2)
	}

	output := displayOutput(result)
	if output != "" && !opts.json {
		fmt.Print(output)
	}
	if timedOut, _ := boolField(result, "timedOut"); timedOut {
		if !opts.json {
			if output != "" && !strings.HasSuffix(output, "\n") {
				fmt.Println()
			}
			fmt.Println("Timeout:", timeoutHintMessage(result))
		}
		os.Exit(124)
	}
	if exitCode, ok := intField(result, "exitCode"); ok && exitCode != 0 {
		if !opts.json {
			if output != "" && !strings.HasSuffix(output, "\n") {
				fmt.Println()
			}
			message := stringField(result, "message")
			if message == "" {
				message = fmt.Sprintf("The remote shell returned exit code %d. gxShell did not block this command.", exitCode)
			}
			fmt.Fprintln(os.Stderr, "Remote failure:", message)
		}
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

func requiresScriptInput(command string) bool {
	return strings.ContainsAny(command, "\r\n") || heredocPattern.MatchString(command)
}

var heredocPattern = regexp.MustCompile(`(?:^|[;&|]\s*|\s)<<-?\s*["']?[A-Za-z_][A-Za-z0-9_]*["']?`)

func fatalScriptInput(opts cliOptions, server string) {
	recommended := fmt.Sprintf("gxshell-cli exec-stdin %s --shell bash", server)
	message := "Multiline commands and heredocs must use exec-stdin or exec-file so script text travels over SSH stdin without nested shell quoting."
	if opts.json {
		printJSON(map[string]any{
			"error": message, "errorKind": "script_input_required", "outcome": "validation_error",
			"blocked": false, "recommendedCommand": recommended,
		})
	} else {
		fmt.Println("Error:", message)
		fmt.Println("Recommended:", recommended)
	}
	os.Exit(1)
}

func handleSecretCommand(args []string, opts cliOptions) {
	if len(args) == 0 {
		fatalErrorKind(opts, 1, "validation", "secret requires set, status, or delete")
	}
	action := args[0]
	alias, nextOpts, err := parseOneArgCommand(args[1:], opts, "secret "+action)
	if err != nil {
		fatalErrorKind(nextOpts, 1, "validation", err.Error())
	}
	switch action {
	case "set":
		data, err := io.ReadAll(os.Stdin)
		if err != nil {
			fatalError(nextOpts, 1, "failed to read secret from stdin: "+err.Error())
		}
		value := strings.TrimRight(string(data), "\r\n")
		if value == "" {
			fatalErrorKind(nextOpts, 1, "validation", "secret set reads a non-empty value from stdin; never pass the value as an argument")
		}
		result := requestJSON("POST", "/cli/secrets", map[string]any{"alias": alias, "value": value}, nextOpts)
		printSecretResult(result, nextOpts, "Stored "+"secret://"+alias)
	case "status":
		result := requestJSON("GET", "/cli/secrets?alias="+url.QueryEscape(alias), nil, nextOpts)
		printSecretResult(result, nextOpts, "")
	case "delete":
		result := requestJSON("DELETE", "/cli/secrets?alias="+url.QueryEscape(alias), nil, nextOpts)
		printSecretResult(result, nextOpts, "Deleted "+"secret://"+alias)
	default:
		fatalErrorKind(nextOpts, 1, "validation", "unknown secret action: "+action)
	}
}

func printSecretResult(result map[string]any, opts cliOptions, success string) {
	if errMsg := stringField(result, "error"); errMsg != "" {
		fatalErrorKind(opts, 1, stringField(result, "errorKind"), errMsg)
	}
	if opts.json {
		printJSON(result)
		return
	}
	if success != "" {
		fmt.Println(success)
		return
	}
	if exists, _ := boolField(result, "exists"); exists {
		fmt.Println(stringField(result, "reference"), "is available (value hidden)")
	} else {
		fmt.Println("secret://"+stringField(result, "alias"), "is not set")
	}
}

func isAllowedShell(shell string) bool {
	switch shell {
	case "sh", "bash", "dash", "zsh", "ksh":
		return true
	default:
		return false
	}
}

func copyRemote(source, destination string, opts cliOptions) {
	sourceServer, sourcePath, err := parseRemoteSpec(source)
	if err != nil {
		fatalErrorKind(opts, 1, "validation", "source: "+err.Error())
	}
	destinationServer, destinationPath, err := parseRemoteSpec(destination)
	if err != nil {
		fatalErrorKind(opts, 1, "validation", "destination: "+err.Error())
	}
	result := requestJSON("POST", "/cli/copy", map[string]any{
		"sourceServer": sourceServer, "sourcePath": sourcePath,
		"destinationServer": destinationServer, "destinationPath": destinationPath,
	}, opts)
	if errMsg := stringField(result, "error"); errMsg != "" {
		fatalErrorKind(opts, 1, stringField(result, "errorKind"), errMsg)
	}
	if opts.json {
		printJSON(result)
		return
	}
	fmt.Printf("Copied %s -> %s\n", stringField(result, "source"), stringField(result, "destination"))
	fmt.Printf("Bytes: %d\nSHA-256: %s\n", int64Field(result, "bytes"), stringField(result, "sha256"))
}

func parseRemoteSpec(value string) (string, string, error) {
	parts := strings.SplitN(value, ":", 2)
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
		return "", "", fmt.Errorf("expected <server>:<remote-path>")
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1]), nil
}

func handleJobCommand(args []string, opts cliOptions) {
	args, opts, err := parseLeadingFlags(args, opts)
	if err != nil {
		fatalErrorKind(opts, 1, "validation", err.Error())
	}
	if len(args) < 2 {
		fatalErrorKind(opts, 1, "validation", "job requires status, logs, or cancel followed by <id>")
	}
	subcommand, id := args[0], args[1]
	rest, opts, err := stripTrailingFlags(args[2:], opts)
	if err != nil || len(rest) != 0 {
		if err == nil {
			err = fmt.Errorf("unexpected job arguments")
		}
		fatalErrorKind(opts, 1, "validation", err.Error())
	}
	switch subcommand {
	case "status":
		showJobStatus(id, opts)
	case "logs":
		if opts.follow {
			followJob(id, opts, true)
		} else {
			showJobLogs(id, opts)
		}
	case "cancel":
		result := requestJSON("DELETE", "/cli/jobs?id="+url.QueryEscape(id), nil, opts)
		if errMsg := stringField(result, "error"); errMsg != "" {
			fatalErrorKind(opts, 1, stringField(result, "errorKind"), errMsg)
		}
		if opts.json {
			printJSON(result)
		} else if requested, _ := boolField(result, "cancelRequested"); requested {
			fmt.Println("Cancellation requested for", id)
		} else {
			fmt.Println("Job is already finished:", id)
		}
	default:
		fatalErrorKind(opts, 1, "validation", "unknown job command: "+subcommand)
	}
}

func showJobStatus(id string, opts cliOptions) {
	result := requestJSON("GET", "/cli/jobs?id="+url.QueryEscape(id), nil, opts)
	if errMsg := stringField(result, "error"); errMsg != "" && stringField(result, "state") == "" {
		fatalErrorKind(opts, 1, stringField(result, "errorKind"), errMsg)
	}
	if opts.json {
		result["events"] = []any{}
		printJSON(result)
		return
	}
	fmt.Printf("%s: %s", id, stringField(result, "state"))
	if exitCode, ok := intField(result, "exitCode"); ok {
		fmt.Printf(" (exit %d)", exitCode)
	}
	fmt.Println()
	if errMsg := stringField(result, "error"); errMsg != "" {
		fmt.Println("Error:", errMsg)
	}
}

func showJobLogs(id string, opts cliOptions) {
	result := requestJSON("GET", "/cli/jobs?id="+url.QueryEscape(id)+"&after=0", nil, opts)
	if errMsg := stringField(result, "error"); errMsg != "" && stringField(result, "state") == "" {
		fatalErrorKind(opts, 1, stringField(result, "errorKind"), errMsg)
	}
	if opts.json {
		printJSON(result)
		return
	}
	printJobEvents(result)
}

func followJob(id string, opts cliOptions, exitWithJob bool) {
	var after int
	allEvents := make([]any, 0)
	for {
		result := requestJSON("GET", fmt.Sprintf("/cli/jobs?id=%s&after=%d", url.QueryEscape(id), after), nil, opts)
		if errMsg := stringField(result, "error"); errMsg != "" && stringField(result, "state") == "" {
			fatalErrorKind(opts, 1, stringField(result, "errorKind"), errMsg)
		}
		if events, ok := result["events"].([]any); ok {
			if opts.json {
				allEvents = append(allEvents, events...)
			} else {
				printJobEvents(result)
			}
			for _, raw := range events {
				if event, ok := raw.(map[string]any); ok {
					if seq, ok := intField(event, "sequence"); ok && seq > after {
						after = seq
					}
				}
			}
		}
		state := stringField(result, "state")
		if isTerminalJobState(state) {
			if opts.json {
				result["events"] = allEvents
				printJSON(result)
			} else if errMsg := stringField(result, "error"); errMsg != "" && state != "cancelled" {
				fmt.Fprintln(os.Stderr, "Error:", errMsg)
			}
			if !exitWithJob {
				return
			}
			if state == "cancelled" {
				os.Exit(130)
			}
			if timedOut, _ := boolField(result, "timedOut"); timedOut {
				os.Exit(124)
			}
			if exitCode, ok := intField(result, "exitCode"); ok && exitCode != 0 {
				os.Exit(normalizeExitCode(exitCode))
			}
			return
		}
		time.Sleep(250 * time.Millisecond)
	}
}

func printJobEvents(result map[string]any) {
	events, _ := result["events"].([]any)
	for _, raw := range events {
		event, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		fmt.Print(stringField(event, "data"))
	}
}

func isTerminalJobState(state string) bool {
	return state == "succeeded" || state == "failed" || state == "cancelled"
}

func handleTunnelCommand(args []string, opts cliOptions) {
	args, opts, err := parseLeadingFlags(args, opts)
	if err != nil {
		fatalErrorKind(opts, 1, "validation", err.Error())
	}
	if len(args) == 0 {
		fatalErrorKind(opts, 1, "validation", "tunnel requires open, socks, list, or close")
	}
	subcommand := args[0]
	positional, opts, err := stripTrailingFlags(args[1:], opts)
	if err != nil {
		fatalErrorKind(opts, 1, "validation", err.Error())
	}
	switch subcommand {
	case "open":
		if len(positional) != 3 {
			fatalErrorKind(opts, 1, "validation", "tunnel open requires <server> <local-port-or-address> <remote-host:port>")
		}
		openTunnel(positional[0], "local", positional[1], positional[2], opts)
	case "socks":
		if len(positional) != 2 {
			fatalErrorKind(opts, 1, "validation", "tunnel socks requires <server> <local-port-or-address>")
		}
		openTunnel(positional[0], "dynamic", positional[1], "", opts)
	case "list":
		if len(positional) != 0 {
			fatalErrorKind(opts, 1, "validation", "tunnel list takes no arguments")
		}
		listTunnels(opts)
	case "close":
		if len(positional) != 1 {
			fatalErrorKind(opts, 1, "validation", "tunnel close requires <id>")
		}
		closeTunnel(positional[0], opts)
	default:
		fatalErrorKind(opts, 1, "validation", "unknown tunnel command: "+subcommand)
	}
}

func openTunnel(server, tunnelType, local, remote string, opts cliOptions) {
	payload := map[string]any{"server": server, "type": tunnelType, "local": local}
	if remote != "" {
		payload["remote"] = remote
	}
	result := requestJSON("POST", "/cli/tunnels", payload, opts)
	if errMsg := stringField(result, "error"); errMsg != "" {
		fatalErrorKind(opts, 1, stringField(result, "errorKind"), errMsg)
	}
	if opts.json {
		printJSON(result)
		return
	}
	fmt.Printf("Opened %s at %s (id: %s)\n", stringField(result, "type"), stringField(result, "local"), stringField(result, "tunnelId"))
	fmt.Println("Close it immediately after use with: gxshell-cli tunnel close " + stringField(result, "tunnelId"))
}

func listTunnels(opts cliOptions) {
	result := requestJSON("GET", "/cli/tunnels", nil, opts)
	if errMsg := stringField(result, "error"); errMsg != "" {
		fatalErrorKind(opts, 1, stringField(result, "errorKind"), errMsg)
	}
	if opts.json {
		printJSON(result)
		return
	}
	items, _ := result["tunnels"].([]any)
	if len(items) == 0 {
		fmt.Println("No temporary CLI tunnels are open.")
		return
	}
	for _, raw := range items {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		fmt.Printf("%s  %s  %s  %s", stringField(item, "tunnelId"), stringField(item, "alias"), stringField(item, "type"), stringField(item, "local"))
		if remote := stringField(item, "remote"); remote != "" {
			fmt.Print(" -> " + remote)
		}
		if active, _ := boolField(item, "active"); !active {
			fmt.Print("  (inactive)")
		}
		fmt.Println()
	}
}

func closeTunnel(id string, opts cliOptions) {
	result := requestJSON("DELETE", "/cli/tunnels?id="+url.QueryEscape(id), nil, opts)
	if errMsg := stringField(result, "error"); errMsg != "" {
		fatalErrorKind(opts, 1, stringField(result, "errorKind"), errMsg)
	}
	if opts.json {
		printJSON(result)
	} else {
		fmt.Println("Closed tunnel", id)
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
		fatalError(opts, 1, "gxShell daemon is not running at "+daemonURL+". Start the gxShell GUI, then run `gxshell-cli doctor` if this keeps failing")
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

func showDoctor(opts cliOptions) {
	report := buildDoctorReport()
	if opts.json {
		printJSON(report)
		return
	}

	fmt.Println("gxShell CLI doctor")
	fmt.Println()
	fmt.Println("Version:       " + stringField(report, "version"))
	fmt.Println("Executable:    " + stringField(report, "executable"))
	fmt.Println("Working dir:   " + stringField(report, "workingDir"))
	fmt.Println("Config dir:    " + stringField(report, "configDir"))
	fmt.Println("Token file:    " + stringField(report, "tokenPath") + " (" + stringField(report, "tokenStatus") + ")")
	fmt.Println("Daemon:        " + stringField(report, "daemonStatus"))
	if detail := stringField(report, "daemonDetail"); detail != "" {
		fmt.Println("Daemon detail: " + detail)
	}
	if inPath, _ := boolField(report, "executableDirInPath"); inPath {
		fmt.Println("PATH:          executable directory is on PATH")
	} else {
		exeDir := stringField(report, "executableDir")
		fmt.Println("PATH:          executable directory is not on PATH")
		if exeDir != "" {
			fmt.Println("PATH hint:     add this directory to PATH to run gxshell-cli from any shell:")
			fmt.Println("               " + exeDir)
		}
	}
}

func buildDoctorReport() map[string]any {
	report := map[string]any{
		"version":   version,
		"daemonURL": daemonURL,
		"os":        runtime.GOOS,
	}

	if cwd, err := os.Getwd(); err == nil {
		report["workingDir"] = cwd
	}
	if exe, err := os.Executable(); err == nil {
		if abs, absErr := filepath.Abs(exe); absErr == nil {
			exe = abs
		}
		exeDir := filepath.Dir(exe)
		report["executable"] = exe
		report["executableDir"] = exeDir
		report["executableDirInPath"] = pathContainsDir(os.Getenv("PATH"), exeDir)
	} else {
		report["executableError"] = err.Error()
	}
	if base, err := os.UserConfigDir(); err == nil {
		report["configDir"] = filepath.Join(base, "gxShell")
	} else {
		report["configDirError"] = err.Error()
	}
	if tokenPath, err := cliTokenPath(); err == nil {
		report["tokenPath"] = tokenPath
		report["tokenStatus"] = tokenStatus(tokenPath)
	} else {
		report["tokenStatus"] = "unavailable"
		report["tokenError"] = err.Error()
	}

	if resp, err := httpClient.Get(daemonURL + "/cli/ping"); err != nil {
		report["daemonStatus"] = "not running"
		report["daemonDetail"] = err.Error()
	} else {
		defer resp.Body.Close()
		if resp.StatusCode == http.StatusOK {
			report["daemonStatus"] = "running"
		} else {
			report["daemonStatus"] = "unexpected status"
			report["daemonDetail"] = resp.Status
		}
	}
	return report
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
		case "--shell":
			if len(args) < 2 {
				return args, opts, fmt.Errorf("--shell requires a value")
			}
			opts.shell = strings.TrimSpace(args[1])
			args = args[2:]
		case "--follow":
			opts.follow = true
			args = args[1:]
		case "--detach":
			opts.detach = true
			args = args[1:]
		case "--secret":
			if len(args) < 2 {
				return args, opts, fmt.Errorf("--secret requires ENV=alias")
			}
			if err := addSecretBinding(&opts, args[1]); err != nil {
				return args, opts, err
			}
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
		if len(out) >= 2 && out[len(out)-2] == "--shell" {
			opts.shell = strings.TrimSpace(out[len(out)-1])
			out = out[:len(out)-2]
			continue
		}
		if last == "--follow" {
			opts.follow = true
			out = out[:len(out)-1]
			continue
		}
		if last == "--detach" {
			opts.detach = true
			out = out[:len(out)-1]
			continue
		}
		if len(out) >= 2 && out[len(out)-2] == "--secret" {
			if err := addSecretBinding(&opts, out[len(out)-1]); err != nil {
				return args, opts, err
			}
			out = out[:len(out)-2]
			continue
		}
		break
	}
	return out, opts, nil
}

func addSecretBinding(opts *cliOptions, binding string) error {
	envName, alias, ok := strings.Cut(binding, "=")
	alias = strings.TrimPrefix(alias, "secret://")
	if !ok || envName == "" || alias == "" {
		return fmt.Errorf("invalid --secret %q; use ENV=alias", binding)
	}
	if opts.secrets == nil {
		opts.secrets = map[string]string{}
	}
	opts.secrets[envName] = alias
	return nil
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
		printJSON(map[string]any{"error": message, "errorKind": kind, "outcome": errorOutcome(kind), "blocked": kind == "blocked"})
	} else {
		fmt.Println("Error:", message)
	}
	os.Exit(code)
}

func errorOutcome(kind string) string {
	switch kind {
	case "blocked":
		return "blocked"
	case "validation", "script_input_required":
		return "validation_error"
	case "remote", "remote_exit":
		return "remote_failed"
	default:
		return "client_error"
	}
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

func blockedMessage(result map[string]any) string {
	if reason := stringField(result, "reason"); reason != "" {
		return reason
	}
	errMsg := stringField(result, "error")
	errMsg = strings.TrimSpace(errMsg)
	errMsg = strings.TrimSpace(strings.TrimPrefix(errMsg, "BLOCKED:"))
	return errMsg
}

func timeoutHintMessage(result map[string]any) string {
	if hint := stringField(result, "timeoutHint"); hint != "" {
		return hint
	}
	timeout := "the configured"
	if timeoutMs, ok := intField(result, "timeoutMs"); ok && timeoutMs > 0 {
		timeout = (time.Duration(timeoutMs) * time.Millisecond).Round(time.Second).String()
	}
	return fmt.Sprintf("Command exceeded the %s remote timeout. The SSH exec channel was closed, but the remote command may have made partial changes or may still be running in the background. Check the remote service/process status before retrying, or rerun with --timeout 10m for expected long operations.", timeout)
}

func loadToken() (string, error) {
	path, err := cliTokenPath()
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	token := strings.TrimSpace(string(raw))
	if token == "" {
		return "", fmt.Errorf("CLI token file is empty")
	}
	return token, nil
}

func cliTokenPath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "gxShell", cliTokenFilename), nil
}

func tokenStatus(path string) string {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "missing"
		}
		return "unreadable: " + err.Error()
	}
	if strings.TrimSpace(string(raw)) == "" {
		return "empty"
	}
	return "present"
}

func pathContainsDir(pathEnv, dir string) bool {
	if strings.TrimSpace(dir) == "" {
		return false
	}
	target, err := filepath.Abs(dir)
	if err != nil {
		target = dir
	}
	target = filepath.Clean(target)
	for _, entry := range filepath.SplitList(pathEnv) {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		abs, err := filepath.Abs(entry)
		if err != nil {
			abs = entry
		}
		if samePath(filepath.Clean(abs), target) {
			return true
		}
	}
	return false
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
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

func int64Field(m map[string]any, key string) int64 {
	switch value := m[key].(type) {
	case float64:
		return int64(value)
	case int64:
		return value
	case int:
		return int64(value)
	default:
		return 0
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
  gxshell-cli [options] <command> [arguments]

COMMANDS:
  exec <server> "<command>"     Execute a command on a CLI-enabled server
  exec-file <server> <file>     Send a script to <shell> -s over SSH stdin
  exec-stdin <server>           Send stdin to <shell> -s over SSH stdin
  secret set <alias>            Store stdin as secret://<alias> (value never in argv)
  secret status <alias>         Check whether a named secret exists
  secret delete <alias>         Delete a named secret
  copy <server:path> <server:path>
                               Copy one remote file atomically and verify SHA-256
  job status <id>              Show a detached/followed job state
  job logs <id> [--follow]     Read or follow ordered job output
  job cancel <id>              Cancel a running job
  tunnel open <server> <local> <remote-host:port>
                               Open a temporary local SSH forward
  tunnel socks <server> <local>
                               Open a temporary SOCKS5 tunnel
  tunnel list                  List temporary CLI tunnels
  tunnel close <id>            Close a temporary CLI tunnel
  list                         List CLI-enabled server aliases
  status                       Show active CLI SSH connections
  ping                         Check if gxShell is running
  doctor                       Show local CLI diagnostics
  help                         Show this help message
  version                      Show version information

SECURITY:
  - The gxShell GUI must be running.
  - Requests require a local token generated by gxShell.
  - Server profiles are hidden unless CLI access is enabled.
  - The CLI lists aliases only, not IP addresses or usernames.
  - Simple read-only commands run without a prompt; other commands ask for native confirmation and may be batched.
  - Run ` + "`gxshell-cli doctor`" + ` to check token, PATH, executable, and daemon state.

OPTIONS:
  --json                       Print machine-readable JSON
  --timeout <duration>          Remote command timeout, e.g. 60, 90s, 5m
  --shell <name>                Script interpreter: sh, bash, dash, zsh, or ksh
  --follow                      Run as a job and stream output until completion
  --detach                      Run as a job and return its ID immediately
  --secret ENV=alias            Inject secret://alias as ENV (sync exec only)

EXAMPLES:
  gxshell-cli exec prod-web "uptime"
  gxshell-cli exec prod-web "docker compose up -d --build" --timeout 10m
  gxshell-cli --timeout 10m exec prod-web "docker compose up -d --build"
  gxshell-cli exec prod-web "journalctl -f" --follow
  gxshell-cli exec-file prod-web deploy.sh --shell bash
  Get-Content deploy.sh | gxshell-cli exec-stdin prod-web --shell bash
  Get-Content api-key.txt -Raw | gxshell-cli secret set anyrouter-api-key
  gxshell-cli exec prod-web 'curl -H "Authorization: Bearer $API_KEY" https://example/api' --secret API_KEY=anyrouter-api-key --json
  gxshell-cli copy 2:/tmp/config.tar 3:/tmp/config.tar
  gxshell-cli tunnel open 2 127.0.0.1:8080 127.0.0.1:80
  gxshell-cli tunnel socks 2 1080
  gxshell-cli tunnel close tun-0123456789abcdef
  gxshell-cli --json exec prod-web "df -h"

SECURITY NOTE:
  CLI tunnels bind only to loopback and are temporary. Record the returned ID,
  close the tunnel immediately after use, and verify with ` + "`gxshell-cli tunnel list`" + `.
`
	fmt.Print(help)
}
