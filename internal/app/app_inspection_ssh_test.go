package app

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gxShell/backend/ai"
	sshmanager "gxShell/backend/ssh"
	"gxShell/backend/types"
	"gxShell/backend/workflow"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// This fixture exercises real TCP/SSH channels with deterministic Linux-shaped
// command results. It does not execute Linux commands or alter a remote machine.
func inspectionSSHFixture(t *testing.T) (types.Profile, string) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	connections := []net.Conn{}
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			connections = append(connections, conn)
			mu.Unlock()
			wg.Add(1)
			go func() {
				defer wg.Done()
				defer conn.Close()
				server, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					return
				}
				defer server.Close()
				go ssh.DiscardRequests(requests)
				for incoming := range channels {
					channel, channelRequests, err := incoming.Accept()
					if err != nil {
						continue
					}
					wg.Add(1)
					go func() {
						defer wg.Done()
						defer channel.Close()
						for request := range channelRequests {
							switch request.Type {
							case "exec":
								var command struct{ Command string }
								_ = ssh.Unmarshal(request.Payload, &command)
								if command.Command != "sh -s" {
									_ = request.Reply(false, nil)
									continue
								}
								_ = request.Reply(true, nil)
								go ssh.DiscardRequests(channelRequests)
								data, err := io.ReadAll(io.LimitReader(channel, 16384))
								if err != nil {
									return
								}
								script := string(data)
								if !strings.HasPrefix(script, "PATH=/usr/sbin:/usr/bin:/sbin:/bin\n") {
									_, _ = io.WriteString(channel.Stderr(), "fixture rejected missing fixed PATH")
									_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{99}))
									return
								}
								output, code := inspectionFixtureOutput(script)
								_, _ = io.WriteString(channel, output)
								_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{code}))
								return
							case "shell":
								_ = request.Reply(true, nil)
								go ssh.DiscardRequests(channelRequests)
								_, _ = io.Copy(io.Discard, channel)
								return
							default:
								_ = request.Reply(true, nil)
							}
						}
					}()
				}
			}()
		}
	}()
	t.Cleanup(func() {
		_ = listener.Close()
		mu.Lock()
		for _, conn := range connections {
			_ = conn.Close()
		}
		mu.Unlock()
		wg.Wait()
	})
	path := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(path, []byte(knownhosts.Line([]string{listener.Addr().String()}, signer.PublicKey())+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return types.Profile{ID: "inspection-fixture", Name: "Local SSH fixture", Host: "127.0.0.1", Port: listener.Addr().(*net.TCPAddr).Port, Username: "fixture", AuthType: types.AuthPassword, Password: "fixture-only"}, path
}

func inspectionFixtureOutput(script string) (string, uint32) {
	switch {
	case strings.Contains(script, "df -Pk"):
		return "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 1000000 980000 20000 98% /\n", 0
	case strings.Contains(script, "df -Pi"):
		return "Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/vda1 100000 20000 80000 20% /\n", 0
	case strings.Contains(script, "systemctl show"):
		return "LoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\n", 0
	case strings.Contains(script, "GXSHELL_TCP="):
		return "GXSHELL_TCP=unreachable\n", 1
	case strings.Contains(script, "ss -lnt"):
		return "State Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0 128 0.0.0.0:8080 0.0.0.0:*\n", 0
	case strings.Contains(script, "docker system df"), strings.Contains(script, "docker ps"):
		return "sh: docker: not found\n", 127
	case strings.Contains(script, "du -x"):
		return "400000\t/var/log\n100000\t/var/cache\n50000\t/home\n10000\t/tmp\n", 0
	case strings.Contains(script, "journalctl --disk-usage"):
		return "Archived and active journals take up 300.0M in the file system.\n", 0
	case strings.Contains(script, "journalctl"):
		return "Example: service stopped normally\n", 0
	case strings.Contains(script, "systemctl --failed"):
		return "GXSHELL_SERVICE_MANAGER=systemd\n", 0
	case strings.Contains(script, "uname"):
		return "Linux 6.8.0 x86_64\n1\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n", 0
	default:
		return "fixture: unexpected command\n", 99
	}
}

func TestInspectionFaultScenariosOverRealSSH(t *testing.T) {
	profile, known := inspectionSSHFixture(t)
	app := NewApp()
	app.ssh = sshmanager.NewManager(known, func(string, any) {}, nil)
	info, err := app.ssh.Connect(profile, 5, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.ssh.Disconnect(info.ID) })
	// The simulated model deliberately labels every check healthy. Backend
	// measured conclusions must still expose service, port and disk faults.
	model := func(_ context.Context, _ ai.Config, req ai.ChatRequest, emit func(ai.ChatResponse)) error {
		var run workflow.Run
		for _, message := range req.Messages {
			if message.Role == "user" {
				var value struct {
					Evidence []workflow.Evidence `json:"evidence"`
				}
				start := strings.Index(message.Content, "{")
				if start >= 0 && json.NewDecoder(strings.NewReader(message.Content[start:])).Decode(&value) == nil && len(value.Evidence) > 0 {
					run.Evidence = value.Evidence
					for _, e := range value.Evidence {
						if e.Query.Check == "disk_usage" {
							run.Workflow = "disk_diagnosis"
						}
						if e.Query.Check == "connectivity" {
							run.Workflow = "service_diagnosis"
						}
					}
				}
			}
		}
		if len(run.Evidence) == 0 {
			return fmt.Errorf("missing workflow evidence")
		}
		doc := workflow.ReportDocument{Version: 2, Verdict: "normal", Summary: "Fixture model claims normal.", Findings: []workflow.Finding{}, Unknowns: []workflow.Uncertainty{}, Checks: []workflow.ReportCheck{}, Analysis: &workflow.AiAnalysis{Assessment: "Fixture assessment.", Insights: []workflow.AiInsight{{Title: "Environment", Opinion: "System information was obtained.", Confidence: "supported", EvidenceIDs: []string{"E1"}, NextCheck: "Check workload expectations."}}, NextSteps: []string{"Verify workload expectations."}, Caveats: "Fixture data only."}}
		for _, check := range workflow.RunChecks(run) {
			var refs []string
			for _, evidence := range run.Evidence {
				if evidence.Query.Check == check {
					refs = append(refs, evidence.ID)
				}
			}
			doc.Checks = append(doc.Checks, workflow.ReportCheck{Check: check, Status: "normal", Reading: "Fixture claims healthy.", EvidenceIDs: refs})
		}
		data, _ := json.Marshal(doc)
		emit(ai.ChatResponse{Content: string(data)})
		emit(ai.ChatResponse{Finish: true})
		return nil
	}
	manager, err := workflow.NewManager(t.TempDir(), app.executeInspectionQuery, model, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Close()
	cfg := ai.Config{Provider: "openai", Model: "local-fixture-model"}
	disk, err := manager.StartDiskDiagnosis(context.Background(), info.ID, profile.ID, profile.Name, "en", cfg)
	if err != nil {
		t.Fatal(err)
	}
	disk = waitInspectionFixture(t, manager, disk.ID)
	if disk.State != "completed" || disk.Document == nil {
		t.Fatalf("disk report incomplete: %+v", disk)
	}
	if disk.Document.Verdict != "attention" || disk.Document.Checks[1].Status != "critical" {
		t.Fatal("98% disk usage was incorrectly healthy")
	}
	for _, e := range disk.Evidence {
		if e.Query.Check == "container_storage" && (e.Status != "unavailable" || e.ExitCode != 127 || !strings.Contains(e.Output, "docker: not found")) {
			t.Fatalf("missing Docker is not an unavailable tool: %+v", e)
		}
	}
	service, err := manager.StartDiagnosis(context.Background(), info.ID, profile.ID, profile.Name, "en", cfg, "nginx.service", 80)
	if err != nil {
		t.Fatal(err)
	}
	service = waitInspectionFixture(t, manager, service.ID)
	if service.State != "completed" || service.Document == nil {
		t.Fatalf("service report incomplete: %+v", service)
	}
	results := map[string]string{}
	for _, check := range service.Document.Checks {
		results[check.Check] = check.Status
	}
	if results["service"] != "warning" || results["connectivity"] != "critical" {
		t.Fatalf("missed stopped service or wrong listening port: %v", results)
	}
}

// Read-only inspection is confirmed once per server, model and background
// revision through the in-app panel; a changed model asks again.
func TestInspectionConsentIsRememberedPerModel(t *testing.T) {
	profile, known := inspectionSSHFixture(t)
	app := NewApp()
	app.ctx.Set(context.Background())
	app.automationEventFn = func(terminalAutomationEvent) {}
	app.ssh = sshmanager.NewManager(known, func(string, any) {}, nil)
	info, err := app.ssh.Connect(profile, 5, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.ssh.Disconnect(info.ID) })
	app.ai = ai.NewManager()
	app.ai.UpdateConfig(ai.Config{Provider: "openai", Model: "fixture-a"})
	model := func(context.Context, ai.Config, ai.ChatRequest, func(ai.ChatResponse)) error {
		return fmt.Errorf("fixture model unavailable")
	}
	app.inspections, err = workflow.NewManager(t.TempDir(), app.executeInspectionQuery, model, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer app.inspections.Close()
	panels := newApprovalPanelHarness(app)
	start := func(approve bool) (workflow.Run, error, bool) {
		type result struct {
			run workflow.Run
			err error
		}
		done := make(chan result, 1)
		go func() { run, err := app.StartAiDiskDiagnosis(info.ID); done <- result{run, err} }()
		select {
		case req := <-panels.requests:
			if req.Source != "ai" || len(req.Items) != 1 || req.Items[0].RiskTier != "T0" {
				t.Fatalf("unexpected panel: %+v", req)
			}
			approved := []string{}
			if approve {
				approved = []string{req.Items[0].ID}
			}
			if err := app.ResolveCliApproval(req.ID, approved); err != nil {
				t.Fatal(err)
			}
			r := <-done
			return r.run, r.err, true
		case r := <-done:
			return r.run, r.err, false
		case <-time.After(5 * time.Second):
			t.Fatal("inspection neither asked nor started")
			return workflow.Run{}, nil, false
		}
	}
	first, err, asked := start(true)
	if err != nil || !asked {
		t.Fatalf("first run: asked=%v err=%v", asked, err)
	}
	waitInspectionFixture(t, app.inspections, first.ID)
	second, err, asked := start(true)
	if err != nil || asked {
		t.Fatalf("remembered consent asked again: asked=%v err=%v", asked, err)
	}
	waitInspectionFixture(t, app.inspections, second.ID)
	app.ai.UpdateConfig(ai.Config{Provider: "openai", Model: "fixture-b"})
	if _, err, asked := start(false); err == nil || !asked {
		t.Fatalf("a new model was not confirmed: asked=%v err=%v", asked, err)
	}
}

func waitInspectionFixture(t *testing.T, manager *workflow.Manager, id string) workflow.Run {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		run, err := manager.Get(id)
		if err != nil {
			t.Fatal(err)
		}
		if workflow.Terminal(run.State) {
			return run
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("fixture inspection did not finish")
	return workflow.Run{}
}
