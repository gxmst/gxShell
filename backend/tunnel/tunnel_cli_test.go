package tunnel

import (
	"net"
	"testing"

	"gxShell/backend/types"
)

func TestAddDynamicTunnelReportsActualPort(t *testing.T) {
	manager := NewManager(func(string, any) {})
	status := manager.AddTunnel("session", nil, types.TunnelRule{
		ID: "temporary", Type: types.TunnelDynamic, Local: "127.0.0.1:0", BindHost: "127.0.0.1",
	})
	defer manager.RemoveTunnel("session", "temporary")
	if !status.Active {
		t.Fatalf("tunnel failed: %s", status.Error)
	}
	_, port, err := net.SplitHostPort(status.Rule.Local)
	if err != nil || port == "0" || port == "" {
		t.Fatalf("reported local endpoint = %q, err=%v", status.Rule.Local, err)
	}
}
