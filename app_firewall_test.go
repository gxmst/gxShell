package main

import (
	"testing"

	"gxShell/backend/types"
)

func TestFirewallRuleMatchesNormalizedReadback(t *testing.T) {
	tests := []struct {
		name     string
		rule     types.FirewallRule
		action   string
		port     string
		protocol string
		source   string
		want     bool
	}{
		{
			name:     "ufw direction suffix is ignored",
			rule:     types.FirewallRule{Action: "ALLOW IN", Port: "8080", Protocol: "tcp"},
			action:   "allow",
			port:     "8080",
			protocol: "tcp",
			want:     true,
		},
		{
			name:     "firewalld reject is deny",
			rule:     types.FirewallRule{Action: "reject", Port: "443", Protocol: "tcp"},
			action:   "deny",
			port:     "443",
			protocol: "TCP",
			want:     true,
		},
		{
			name:     "drop is deny",
			rule:     types.FirewallRule{Action: "drop", Port: "53", Protocol: "udp"},
			action:   "deny",
			port:     "53",
			protocol: "udp",
			want:     true,
		},
		{
			name:     "port range separators are equivalent",
			rule:     types.FirewallRule{Action: "allow", Port: "8000:8100", Protocol: "tcp"},
			action:   "accept",
			port:     "8000-8100",
			protocol: "tcp",
			want:     true,
		},
		{
			name:     "cidr host bits normalize to the network",
			rule:     types.FirewallRule{Action: "allow", Port: "22", Protocol: "tcp", Source: "10.0.0.0/24"},
			action:   "allow",
			port:     "22",
			protocol: "tcp",
			source:   "10.0.0.1/24",
			want:     true,
		},
		{
			name:     "different source must not produce a false positive",
			rule:     types.FirewallRule{Action: "allow", Port: "22", Protocol: "tcp", Source: "10.0.0.0/24"},
			action:   "allow",
			port:     "22",
			protocol: "tcp",
			source:   "10.0.1.0/24",
			want:     false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := firewallRuleMatches(test.rule, test.action, test.port, test.protocol, test.source); got != test.want {
				t.Fatalf("firewallRuleMatches() = %t, want %t", got, test.want)
			}
		})
	}
}
