package main

// Post-connect actions: the per-profile start directory, environment variables
// and login commands that run once a session's shell is ready.
//
// These are typed into the interactive shell rather than run over an exec
// channel or negotiated through the SSH protocol, because the point is to affect
// the shell the user is about to type in. An exec channel gets its own process
// (its cd and export die with it), and sshd rejects unknown environment requests
// unless AcceptEnv is configured, which it usually is not.

import (
	"strings"
	"time"

	"gxShell/backend/logger"
	"gxShell/backend/types"
)

// postConnectSettleDelay gives the remote shell time to emit its prompt before
// input is typed. Without it the first command races the shell's own startup
// (motd, profile scripts) and can be swallowed or echoed into a half-drawn
// prompt. This is inherently a heuristic: there is no in-band signal for "the
// prompt is ready" that works across shells.
const postConnectSettleDelay = 600 * time.Millisecond

// maxPostConnectCommands bounds how much a single profile can inject. A profile
// is user-authored, so this is a guard against a corrupted or hand-edited
// profiles.json, not against an attacker.
const maxPostConnectCommands = 32

// postConnectScript renders a profile's post-connect actions into the lines to
// type into its shell. It returns nil when the profile has none.
//
// Order is start directory, then environment, then commands: a login command
// should see the directory and variables the profile promised.
func postConnectScript(profile types.Profile) []string {
	var lines []string

	if dir := sanitizeShellValue(profile.StartDirectory); dir != "" {
		// cd, quoted, so a path with spaces works and a path with shell
		// metacharacters cannot turn into a second command.
		lines = append(lines, "cd "+singleQuote(dir))
	}

	for _, entry := range profile.Environment {
		name, value, ok := splitEnvEntry(entry)
		if !ok {
			continue
		}
		lines = append(lines, "export "+name+"="+singleQuote(value))
	}

	for _, command := range profile.LoginCommands {
		// Login commands are deliberately raw shell: the user wrote them to be
		// executed as written, so quoting them would defeat the feature. Only
		// control characters are removed, so one entry cannot silently become
		// several lines of input.
		command = sanitizeShellValue(command)
		if command == "" {
			continue
		}
		lines = append(lines, command)
	}

	if len(lines) > maxPostConnectCommands {
		lines = lines[:maxPostConnectCommands]
	}
	return lines
}

// splitEnvEntry parses a "KEY=VALUE" entry. It rejects anything whose name is
// not a plain shell identifier, since that is what `export NAME=` requires and
// an odd name is more likely a typo than an intent.
func splitEnvEntry(entry string) (name string, value string, ok bool) {
	entry = sanitizeShellValue(entry)
	index := strings.IndexByte(entry, '=')
	if index <= 0 {
		return "", "", false
	}
	name = strings.TrimSpace(entry[:index])
	value = entry[index+1:]
	if !isShellIdentifier(name) {
		return "", "", false
	}
	return name, value, true
}

func isShellIdentifier(name string) bool {
	if name == "" {
		return false
	}
	for i, r := range name {
		isLetter := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '_'
		isDigit := r >= '0' && r <= '9'
		if !isLetter && !(isDigit && i > 0) {
			return false
		}
	}
	return true
}

// sanitizeShellValue strips the characters that would let one configured value
// become more than one line of terminal input: newlines end a command, and the
// C0 range includes bytes a terminal interprets rather than displays.
func sanitizeShellValue(value string) string {
	value = strings.Map(func(r rune) rune {
		if r == '\n' || r == '\r' || r == 0x7f || (r < 0x20 && r != '\t') {
			return -1
		}
		return r
	}, value)
	return strings.TrimSpace(value)
}

// singleQuote wraps a value in single quotes for POSIX shells, escaping any
// embedded single quote by closing and reopening the string. The result is a
// single word no matter what the value contains.
func singleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// postConnectPayload combines all actions into one SSH write. Keeping the
// write atomic prevents another producer from interleaving bytes between the
// generated lines; login commands must still be non-interactive so one command
// cannot consume the following line as input.
func postConnectPayload(profile types.Profile) string {
	lines := postConnectScript(profile)
	if len(lines) == 0 {
		return ""
	}
	return strings.Join(lines, "\n") + "\n"
}

// runPostConnectActions types a profile's post-connect actions into its shell.
// It runs before Connect returns the session to the frontend, so the user cannot
// type a partial command that gets joined with this script. The fixed delay is
// still a shell-startup heuristic, but SSH buffers the single write until the
// remote process reads it.
func (a *App) runPostConnectActions(sessionID string, profile types.Profile) {
	payload := postConnectPayload(profile)
	if payload == "" {
		return
	}

	time.Sleep(postConnectSettleDelay)
	if err := a.ssh.Write(sessionID, payload); err != nil && a.log != nil {
		a.log.InfoFields("post-connect action stopped", logger.LogFields{
			"session": sessionID,
			"reason":  err.Error(),
		})
	}
}
