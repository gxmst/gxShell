package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"gxShell/backend/mcpserver"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func runMCPCommand(args []string, out io.Writer) error {
	config := len(args) > 0 && args[0] == "config"
	if config {
		args = args[1:]
	}
	flags := flag.NewFlagSet("mcp", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	transport := flags.String("transport", "stdio", "stdio or http")
	client := flags.String("client", "", "claude or codex (config only)")
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			_, err = fmt.Fprintln(out, "gxShell MCP\n\n  gxshell-cli mcp [--transport stdio]\n  gxshell-cli mcp config --client claude|codex --transport stdio|http\n\nStreamable HTTP is served by the GUI at "+daemonURL+"/mcp.\nEnable CLI / MCP access in gxShell settings and restart the GUI.\nHTTP clients authenticate using the local cli_token as a Bearer token.\nMCP stdio writes only protocol messages to stdout; errors go to stderr.")
			return err
		}
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected MCP arguments")
	}
	if *transport != "stdio" && *transport != "http" {
		return fmt.Errorf("transport must be stdio or http")
	}
	if config {
		if *client != "claude" && *client != "codex" {
			return fmt.Errorf("config requires --client claude or codex")
		}
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		return writeMCPConfig(out, *client, *transport, executable)
	}
	if *client != "" {
		return fmt.Errorf("--client is only valid for mcp config")
	}
	if *transport == "http" {
		return fmt.Errorf("HTTP is already hosted by the gxShell GUI at %s/mcp; use mcp config --client claude or codex --transport http", daemonURL)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server := mcpserver.New(mcpserver.HTTPCaller(daemonURL, loadToken))
	return server.Run(ctx, &mcp.StdioTransport{MaxLineLength: mcpserver.MaxRequestBytes})
}

func writeMCPConfig(out io.Writer, client, transport, executable string) error {
	if client == "claude" {
		entry := map[string]any{"timeout": 1860000}
		if transport == "http" {
			entry["type"] = "http"
			entry["url"] = daemonURL + "/mcp"
			entry["headers"] = map[string]string{"Authorization": "Bearer ${GXSHELL_MCP_TOKEN}"}
		} else {
			entry["type"] = "stdio"
			entry["command"] = executable
			entry["args"] = []string{"mcp"}
		}
		encoder := json.NewEncoder(out)
		encoder.SetIndent("", "  ")
		return encoder.Encode(map[string]any{"mcpServers": map[string]any{"gxshell": entry}})
	}
	_, err := fmt.Fprintln(out, "[mcp_servers.gxshell]")
	if err != nil {
		return err
	}
	if transport == "http" {
		_, err = fmt.Fprintf(out, "url = %q\nbearer_token_env_var = %q\n", daemonURL+"/mcp", "GXSHELL_MCP_TOKEN")
	} else {
		// JSON string quoting is also valid TOML basic-string quoting, including
		// escaped backslashes in a Windows executable path.
		path, marshalErr := json.Marshal(executable)
		if marshalErr != nil {
			return marshalErr
		}
		_, err = fmt.Fprintf(out, "command = %s\nargs = [\"mcp\"]\n", path)
	}
	if err == nil {
		_, err = fmt.Fprintln(out, "tool_timeout_sec = 1860")
	}
	return err
}
