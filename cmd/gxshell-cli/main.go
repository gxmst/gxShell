package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	daemonURL        = "http://127.0.0.1:56789"
	cliTokenFilename = "cli_token"
	version          = "1.1.1"
)

var httpClient = &http.Client{Timeout: 6 * time.Minute}

func main() {
	if len(os.Args) < 2 {
		showHelp()
		return
	}

	switch os.Args[1] {
	case "exec":
		if len(os.Args) < 4 {
			fmt.Println("Error: exec requires <server> and <command>")
			fmt.Println("Usage: gxshell-cli exec <server> \"<command>\"")
			os.Exit(1)
		}
		execCommand(os.Args[2], strings.Join(os.Args[3:], " "))
	case "list":
		listServers()
	case "status":
		showStatus()
	case "ping":
		checkDaemon()
	case "help", "--help", "-h":
		showHelp()
	case "version", "--version", "-v":
		fmt.Printf("gxshell-cli version %s\n", version)
	default:
		fmt.Printf("Unknown command: %s\n\n", os.Args[1])
		showHelp()
		os.Exit(1)
	}
}

func execCommand(server, command string) {
	result := requestJSON("POST", "/cli/exec", map[string]string{
		"server":  server,
		"command": command,
	})

	if blocked, ok := result["blocked"].(bool); ok && blocked {
		fmt.Println("BLOCKED:", stringField(result, "error"))
		if reason := stringField(result, "reason"); reason != "" {
			fmt.Println("Reason:", reason)
		}
		os.Exit(2)
	}

	if output := stringField(result, "output"); output != "" {
		fmt.Print(output)
	}
	if timedOut, _ := boolField(result, "timedOut"); timedOut {
		os.Exit(124)
	}
	if exitCode, ok := intField(result, "exitCode"); ok && exitCode != 0 {
		os.Exit(normalizeExitCode(exitCode))
	}

	if errMsg := stringField(result, "error"); errMsg != "" {
		fmt.Println("Error:", errMsg)
		if output := stringField(result, "output"); output != "" {
			fmt.Println("\nPartial output:")
			fmt.Print(output)
		}
		os.Exit(1)
	}
}

func listServers() {
	result := requestJSON("GET", "/cli/list", nil)
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

func showStatus() {
	result := requestJSON("GET", "/cli/status", nil)
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

func checkDaemon() {
	resp, err := httpClient.Get(daemonURL + "/cli/ping")
	if err != nil {
		fmt.Println("gxShell daemon is not running")
		fmt.Println("Please start the gxShell GUI application.")
		os.Exit(1)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fmt.Println("gxShell daemon returned:", resp.Status)
		os.Exit(1)
	}
	fmt.Println("gxShell daemon is running")
}

func requestJSON(method, path string, payload any) map[string]any {
	token, err := loadToken()
	if err != nil {
		fmt.Println("Error:", err.Error())
		fmt.Println("Start gxShell once so it can create the local CLI token.")
		os.Exit(1)
	}

	var body io.Reader
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			fmt.Println("Error: failed to encode request:", err.Error())
			os.Exit(1)
		}
		body = bytes.NewReader(raw)
	}

	req, err := http.NewRequest(method, daemonURL+path, body)
	if err != nil {
		fmt.Println("Error: failed to create request:", err.Error())
		os.Exit(1)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		fmt.Println("Error: Cannot connect to gxShell.")
		fmt.Println("Please start the gxShell GUI application first.")
		os.Exit(1)
	}
	defer resp.Body.Close()

	var result map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		fmt.Println("Error: failed to parse response:", err.Error())
		os.Exit(1)
	}
	if resp.StatusCode == http.StatusUnauthorized {
		fmt.Println("Error: unauthorized CLI request.")
		fmt.Println("Restart gxShell and rebuild or rerun this CLI from the same user account.")
		os.Exit(1)
	}
	return result
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
  - Simple read-only commands run without a prompt; other commands ask for native confirmation each time.
`
	fmt.Print(help)
}
