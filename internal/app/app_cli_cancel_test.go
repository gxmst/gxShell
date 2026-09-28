package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"gxShell/backend/logger"
	sshmanager "gxShell/backend/ssh"
	"gxShell/backend/types"
)

// Cancel immediately after the handler's first successful context check.
// A coalesced connection then returns successfully, just as when its network
// round trip finishes after the HTTP caller has disconnected.
type cancelAfterCheckContext struct {
	context.Context
	once   sync.Once
	cancel context.CancelFunc
}

func (c *cancelAfterCheckContext) Err() error {
	err := c.Context.Err()
	c.once.Do(c.cancel)
	return err
}

func TestCliExecDoesNotStartAfterCallerLeavesDuringConnection(t *testing.T) {
	for _, async := range []string{"true", "false"} {
		t.Run(async, func(t *testing.T) {
			app := newProfileTestApp(t)
			app.log = logger.New(t.TempDir())
			defer app.log.Close()
			app.ssh = sshmanager.NewManager("", nil, nil)
			profile := types.Profile{ID: "test", Name: "test", CliEnabled: true, CliAlias: "test"}
			if err := app.store.SaveProfiles([]types.Profile{profile}); err != nil {
				t.Fatal(err)
			}
			connection := &cliConnectCall{done: make(chan struct{}), res: cliConnectResult{sessionID: "connected"}}
			close(connection.done)
			app.cliConnecting = map[string]*cliConnectCall{profile.ID: connection}
			base, cancel := context.WithCancel(context.Background())
			defer cancel()
			ctx := &cancelAfterCheckContext{Context: base, cancel: cancel}
			req := httptest.NewRequest(http.MethodPost, "/cli/exec", strings.NewReader(`{"server":"test","command":"uptime","async":`+async+`}`)).WithContext(ctx)
			response := httptest.NewRecorder()
			app.handleCliExec(response, req)
			if base.Err() == nil {
				t.Fatal("test did not cancel the caller")
			}
			if len(app.cliJobs) != 0 {
				t.Fatal("detached job accepted after caller cancelled")
			}
			if response.Body.Len() != 0 {
				t.Fatalf("handler proceeded past cancelled connection: %s", response.Body.String())
			}
		})
	}
}
