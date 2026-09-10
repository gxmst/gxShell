package app

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strings"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func mergeBackupKnownHosts(existing, incoming string) (string, int, []string, error) {
	file, err := os.CreateTemp("", "gxshell-host-keys-*")
	if err != nil {
		return "", 0, nil, err
	}
	defer os.Remove(file.Name())
	if _, err := file.WriteString(existing); err != nil {
		_ = file.Close()
		return "", 0, nil, err
	}
	if err := file.Close(); err != nil {
		return "", 0, nil, err
	}
	callback, err := knownhosts.New(file.Name())
	if err != nil {
		return "", 0, nil, fmt.Errorf("invalid existing host keys: %w", err)
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(existing, "\n") {
		seen[strings.TrimSpace(line)] = true
	}
	result := strings.TrimRight(existing, "\r\n")
	added := 0
	var warnings []string
	newKeys := map[string]string{}
	for _, line := range strings.Split(incoming, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") || seen[line] {
			continue
		}
		marker, hosts, key, _, _, err := ssh.ParseKnownHosts([]byte(line))
		if err != nil {
			return "", 0, nil, errors.New("backup contains invalid host keys")
		}
		seen[line] = true
		fingerprint := ssh.FingerprintSHA256(key)
		var accepted []string
		for _, host := range hosts {
			if marker != "" || strings.ContainsAny(host, "|*?!") {
				if strings.TrimSpace(existing) == "" {
					accepted = append(accepted, host)
				} else {
					warnings = append(warnings, "Special host-key entry requires review: "+host)
				}
				continue
			}
			address := host
			if !strings.HasPrefix(address, "[") {
				address = net.JoinHostPort(host, "22")
			}
			err := callback(address, &net.TCPAddr{}, key)
			if err == nil {
				continue
			}
			var keyErr *knownhosts.KeyError
			if !errors.As(err, &keyErr) || len(keyErr.Want) > 0 {
				warnings = append(warnings, "Existing host key retained: "+host+"; incoming "+fingerprint)
				continue
			}
			identity := strings.ToLower(host) + "\x00" + key.Type()
			if prior := newKeys[identity]; prior != "" {
				if prior != fingerprint {
					return "", 0, nil, fmt.Errorf("conflicting host keys in backup: %s", host)
				}
				continue
			}
			newKeys[identity] = fingerprint
			accepted = append(accepted, host)
		}
		if len(accepted) == 0 {
			continue
		}
		if result != "" {
			result += "\n"
		}
		if marker != "" {
			result += "@" + marker + " "
		}
		result += knownhosts.Line(accepted, key)
		added++
	}
	if result != "" {
		result += "\n"
	}
	// The SSH parser also validates hashed-host encodings and marker semantics.
	if err := os.WriteFile(file.Name(), []byte(result), 0600); err != nil {
		return "", 0, nil, err
	}
	if _, err := knownhosts.New(file.Name()); err != nil {
		return "", 0, nil, errors.New("invalid merged host keys")
	}
	return result, added, warnings, nil
}
