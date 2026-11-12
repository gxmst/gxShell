package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gxShell/backend/types"
)

func TestCliResourceApprovalsCloseWhenCallerDisconnects(t *testing.T) {
	for _, operation := range []string{"transfer", "tunnel", "secret-update", "secret-delete"} {
		t.Run(operation, func(t *testing.T) {
			app := newProfileTestApp(t)
			app.ctx.Set(context.Background())
			app.cliApprovalDelay = time.Millisecond
			profile := types.Profile{ID: "test", Name: "test", CliEnabled: true, CliAlias: "test"}
			if err := app.store.SaveProfiles([]types.Profile{profile}); err != nil {
				t.Fatal(err)
			}
			h := newApprovalPanelHarness(app)
			method, endpoint, body := http.MethodPost, "/cli/secrets", `{"Alias":"review-test","Value":"test-only-value"}`
			handler := app.handleCliSecrets
			switch operation {
			case "transfer":
				local := filepath.Join(t.TempDir(), "test.txt")
				if err := os.WriteFile(local, []byte("test-only"), 0600); err != nil {
					t.Fatal(err)
				}
				encoded, _ := json.Marshal(map[string]any{"server": "test", "operation": "push", "localPath": local, "remotePath": "/tmp/review-test"})
				endpoint, body, handler = "/cli/transfer", string(encoded), app.handleCliTransfer
			case "tunnel":
				endpoint, body, handler = "/cli/tunnels", `{"server":"test","type":"local","local":"127.0.0.1:8080","remote":"127.0.0.1:80"}`, app.handleCliTunnels
			case "secret-delete":
				method, endpoint, body = http.MethodDelete, "/cli/secrets?alias=review-test", ""
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			request := httptest.NewRequest(method, endpoint, strings.NewReader(body)).WithContext(ctx)
			done := make(chan struct{})
			go func() { defer close(done); handler(httptest.NewRecorder(), request) }()
			panel := h.nextRequest(t)
			cancel()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("cancelled handler kept waiting for approval")
			}
			select {
			case id := <-h.closed:
				if id != panel.ID {
					t.Fatal("wrong panel closed")
				}
			case <-time.After(5 * time.Second):
				t.Fatal("cancelled approval stayed open")
			}
			if err := app.ResolveCliApproval(panel.ID, []string{panel.Items[0].ID}); err != nil {
				t.Fatal(err)
			}
			if app.approvalPanel.len() != 0 {
				t.Fatal("stale approval survived cancellation")
			}
		})
	}
}
