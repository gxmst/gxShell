package sftpmanager

import "testing"

func TestCleanRemotePath(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"empty", "", "."},
		{"dot", ".", "."},
		{"simple path", "home/user", "home/user"},
		{"absolute path", "/home/user", "/home/user"},
		{"trailing slash", "/home/user/", "/home/user"},
		{"double slash", "/home//user", "/home/user"},
		{"dot in path", "/home/./user", "/home/user"},
		{"traversal up", "/home/user/../admin", "/home/admin"},
		{"traversal up to root", "/home/../etc", "/etc"},
		{"multiple traversal", "/a/b/../../c", "/c"},
		{"traversal beyond root", "/../etc", "/etc"},
		{"relative traversal", "a/../b", "b"},
		{"complex traversal", "/a/b/c/../../d", "/a/d"},
		{"only traversal", "..", "."},
		{"multiple dots", "../../..", "."},
		{"dot dot in middle", "a/b/../../c", "c"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := cleanRemotePath(tt.input)
			if got != tt.want {
				t.Errorf("cleanRemotePath(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}
