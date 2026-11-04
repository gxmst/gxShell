package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPStdioHelper(t *testing.T) {
	if os.Getenv("GXSHELL_MCP_TEST_HELPER") != "1" {
		return
	}
	if err := runMCPCommand([]string{"--transport", "stdio"}, os.Stdout); err != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

func TestMCPStdioProcessHandshakeAndCleanShutdown(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMCPStdioHelper$")
	command.Env = append(os.Environ(), "GXSHELL_MCP_TEST_HELPER=1")
	var stderr bytes.Buffer
	command.Stderr = &stderr
	client := mcp.NewClient(&mcp.Implementation{Name: "stdio-test"}, nil)
	session, err := client.Connect(ctx, &mcp.CommandTransport{Command: command}, nil)
	if err != nil {
		t.Fatalf("connect: %v, stderr: %s", err, stderr.String())
	}
	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools.Tools) != 7 || session.InitializeResult().ServerInfo.Name != "gxShell" {
		t.Fatalf("handshake: %#v", tools)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if command.ProcessState == nil || !command.ProcessState.Success() {
		t.Fatalf("MCP process did not exit cleanly: %s", stderr.String())
	}
}

func TestMCPConfigUsesTransportAndEscapesExecutable(t *testing.T) {
	for _, transport := range []string{"stdio", "http"} {
		var buf bytes.Buffer
		if err := writeMCPConfig(&buf, "claude", transport, `C:\Apps With Spaces\gxShell\gxshell-cli.exe`); err != nil {
			t.Fatal(err)
		}
		var config struct {
			Servers map[string]map[string]any `json:"mcpServers"`
		}
		if err := json.Unmarshal(buf.Bytes(), &config); err != nil {
			t.Fatal(err)
		}
		entry := config.Servers["gxshell"]
		if entry["type"] != transport {
			t.Fatalf("config = %s", buf.String())
		}
		if transport == "http" && !strings.Contains(buf.String(), "${GXSHELL_MCP_TOKEN}") {
			t.Fatal("missing token environment reference")
		}
		buf.Reset()
		if err := writeMCPConfig(&buf, "codex", transport, `C:\Apps With Spaces\gxShell\gxshell-cli.exe`); err != nil {
			t.Fatal(err)
		}
		if transport == "stdio" && !strings.Contains(buf.String(), `C:\\Apps With Spaces\\gxShell\\gxshell-cli.exe`) {
			t.Fatalf("unescaped TOML path: %s", buf.String())
		}
		if transport == "http" && !strings.Contains(buf.String(), `bearer_token_env_var = "GXSHELL_MCP_TOKEN"`) {
			t.Fatal("missing bearer env config")
		}
	}
}

func TestMCPCommandRejectsUnsupportedArguments(t *testing.T) {
	for _, args := range [][]string{{"--transport", "invalid"}, {"config"}, {"--client", "claude"}, {"extra"}, {"--transport", "http"}} {
		var out bytes.Buffer
		if err := runMCPCommand(args, &out); err == nil {
			t.Fatalf("accepted %v", args)
		}
		if out.Len() != 0 {
			t.Fatalf("error polluted stdout: %s", out.String())
		}
	}
}
