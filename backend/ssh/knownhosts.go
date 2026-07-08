package sshmanager

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// KnownHostEntry is one trusted host key, as shown in the settings UI.
type KnownHostEntry struct {
	Hosts       string `json:"hosts"`
	KeyType     string `json:"keyType"`
	Fingerprint string `json:"fingerprint"`
}

// ListKnownHosts parses the app-managed known_hosts file. Unparseable lines
// (comments, hashed entries from other tools) are skipped rather than errors:
// the list is a management view, not a validator.
func (m *Manager) ListKnownHosts() ([]KnownHostEntry, error) {
	knownHostsWriteMu.Lock()
	defer knownHostsWriteMu.Unlock()
	data, err := os.ReadFile(m.knownHostsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return []KnownHostEntry{}, nil
		}
		return nil, err
	}
	entries := []KnownHostEntry{}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		_, hosts, pubKey, _, _, err := ssh.ParseKnownHosts([]byte(line))
		if err != nil {
			continue
		}
		entries = append(entries, KnownHostEntry{
			Hosts:       strings.Join(hosts, ","),
			KeyType:     pubKey.Type(),
			Fingerprint: ssh.FingerprintSHA256(pubKey),
		})
	}
	return entries, nil
}

// RemoveKnownHost deletes the entry whose host list and fingerprint both
// match. The next connection to that host goes through trust-on-first-use
// again.
func (m *Manager) RemoveKnownHost(hosts string, fingerprint string) error {
	knownHostsWriteMu.Lock()
	defer knownHostsWriteMu.Unlock()
	data, err := os.ReadFile(m.knownHostsPath)
	if err != nil {
		return err
	}
	var kept []string
	removed := false
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		_, lineHosts, pubKey, _, _, parseErr := ssh.ParseKnownHosts([]byte(trimmed))
		if parseErr == nil &&
			strings.Join(lineHosts, ",") == hosts &&
			ssh.FingerprintSHA256(pubKey) == fingerprint {
			removed = true
			continue
		}
		kept = append(kept, trimmed)
	}
	if !removed {
		return errors.New("known-hosts entry not found")
	}
	return writeKnownHostsFile(m.knownHostsPath, kept)
}

// replaceKnownHost drops every stored key for hostPort and appends newLine.
// A multi-host line (written by other tools) only loses the matching host;
// keys for its other hosts survive on a rebuilt line.
func replaceKnownHost(path string, hostPort string, newLine string) error {
	knownHostsWriteMu.Lock()
	defer knownHostsWriteMu.Unlock()
	data, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	var kept []string
	for _, line := range strings.Split(string(data), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		_, lineHosts, pubKey, _, _, parseErr := ssh.ParseKnownHosts([]byte(trimmed))
		if parseErr != nil {
			// Not ours to interpret (comment, hashed entry): keep verbatim.
			kept = append(kept, trimmed)
			continue
		}
		var remaining []string
		for _, h := range lineHosts {
			if !strings.EqualFold(h, hostPort) {
				remaining = append(remaining, h)
			}
		}
		if len(remaining) == len(lineHosts) {
			kept = append(kept, trimmed)
		} else if len(remaining) > 0 {
			kept = append(kept, knownhosts.Line(remaining, pubKey))
		}
	}
	kept = append(kept, newLine)
	return writeKnownHostsFile(path, kept)
}

func writeKnownHostsFile(path string, lines []string) error {
	content := ""
	if len(lines) > 0 {
		content = strings.Join(lines, "\n") + "\n"
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return os.WriteFile(path, []byte(content), 0600)
	}
	return nil
}

// fingerprintOfWanted formats the previously trusted key fingerprints from a
// knownhosts mismatch for display in the host-key-changed dialog.
func fingerprintOfWanted(keyErr *knownhosts.KeyError) string {
	fps := make([]string, 0, len(keyErr.Want))
	for _, want := range keyErr.Want {
		fps = append(fps, fmt.Sprintf("%s (%s)", ssh.FingerprintSHA256(want.Key), want.Key.Type()))
	}
	return strings.Join(fps, ", ")
}
