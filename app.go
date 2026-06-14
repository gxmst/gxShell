package main

import (
	"context"
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"gxShell/backend/ai"
	"gxShell/backend/config"
	"gxShell/backend/docker"
	"gxShell/backend/localterm"
	"gxShell/backend/logger"
	"gxShell/backend/monitor"
	"gxShell/backend/network"
	"gxShell/backend/secrets"
	sftpmanager "gxShell/backend/sftp"
	sshmanager "gxShell/backend/ssh"
	"gxShell/backend/tunnel"
	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the main application struct that coordinates all managers.
type App struct {
	ctx             context.Context
	store           *config.Store
	log             *logger.Logger
	ssh             *sshmanager.Manager
	sftp            *sftpmanager.Manager
	monitor         *monitor.Manager
	secrets         *secrets.Store
	net             *network.Manager
	tunnels         *tunnel.Manager
	ai              *ai.Manager
	docker          *docker.Manager
	local           *localterm.Manager
	aiToolMu        sync.Mutex
	aiTools         map[string]authorizedAIToolCall
	cliMu           sync.Mutex
	rateLimiter     *connectionRateLimiter
	startupFilePath string
	startedAt       time.Time
	// allowedFiles is the set of local file paths the user has genuinely chosen
	// to open (via the native file dialog, the startup file-open, or as a
	// markdown sibling of an already-allowed file). ReadLocalFile/WriteLocalFile
	// only operate on paths in this set, so a compromised renderer cannot use
	// them to read or overwrite arbitrary files on disk.
	allowedFilesMu sync.Mutex
	allowedFiles   map[string]bool
}

const aiConfigSecretID = "ai-config"

type terminalSessionBackend interface {
	Disconnect(id string) error
	Write(id string, data string) error
	Resize(id string, cols int, rows int) error
	Get(id string) (types.SessionInfo, error)
	List() []types.SessionInfo
}

type authorizedAIToolCall struct {
	SessionID  string
	ToolCallID string
	ToolName   string
	Arguments  string
	ExpiresAt  time.Time
}

// NewApp creates a new App instance.
func NewApp() *App {
	return &App{
		aiTools:      map[string]authorizedAIToolCall{},
		rateLimiter:  newConnectionRateLimiter(),
		allowedFiles: map[string]bool{},
	}
}

// startup initializes all managers and loads configuration.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	a.startedAt = time.Now()
	store, err := config.NewStore()
	if err != nil {
		runtime.LogError(ctx, "failed to create config store: "+err.Error())
		runtime.Quit(ctx)
		return
	}
	a.store = store
	a.log = logger.New(store.DataDir())
	a.secrets = secrets.NewStore(a.store.DataDir())

	emit := func(event string, data any) {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, event, data)
		}
	}

	confirm := func(host string, fingerprint string) bool {
		if a.ctx == nil {
			return false
		}
		res, _ := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
			Type:          runtime.QuestionDialog,
			Title:         "Unknown Host Key",
			Message:       fmt.Sprintf("The host key for %s is unknown.\nFingerprint: %s\n\nDo you want to trust this host and continue connecting?", host, fingerprint),
			DefaultButton: "No",
		})
		return res == "Yes"
	}

	a.ssh = sshmanager.NewManager(filepath.Join(a.store.DataDir(), "known_hosts"), emit, confirm)
	a.sftp = sftpmanager.NewManager(a.ssh, emit)
	a.monitor = monitor.NewManager(a.ssh, emit)
	a.net = network.NewManager(emit)
	a.net.SetLogDebug(func(format string, args ...any) {
		a.log.Info(fmt.Sprintf(format, args...))
	})
	a.tunnels = tunnel.NewManager(emit)
	a.ai = ai.NewManager()
	a.docker = docker.NewManager(a.ssh)
	a.docker.SetEmit(emit)
	a.local = localterm.NewManager(emit)

	if settings, err := a.store.GetSettings(); err == nil {
		apiKey := settings.Ai.APIKey
		if settings.Ai.APIKey != "" {
			if err := a.secrets.SavePassword(aiConfigSecretID, settings.Ai.APIKey); err == nil {
				settings.Ai.APIKey = ""
				_ = a.store.SaveSettings(settings)
			}
		}
		if stored, err := a.secrets.GetPassword(aiConfigSecretID); err == nil && stored != "" {
			apiKey = stored
		}
		a.ai.UpdateConfig(ai.Config{
			Provider: ai.Provider(settings.Ai.Provider),
			APIKey:   apiKey,
			Endpoint: settings.Ai.Endpoint,
			Model:    settings.Ai.Model,
		})
	}

	a.migrateSecrets()
	a.migrateCliProfileFlags()
	a.store.MigrateSettingsDefaults()
	a.log.Info("gxShell started")

	// Start the CLI server only when the user has left it enabled. A missing
	// setting is migrated to true by MigrateSettingsDefaults above, so existing
	// installs keep their prior behaviour.
	if settings, err := a.store.GetSettings(); err != nil {
		a.log.ErrorFields("CLI server disabled because settings could not be read", logger.LogFields{"error": err.Error()})
	} else if settings.CliServerEnabled {
		go a.startCliServer()
	} else {
		a.log.Info("CLI server disabled by settings")
	}
}

// domReady is called when the frontend is ready.
func (a *App) domReady(ctx context.Context) {
	a.ctx = ctx
	runtime.WindowCenter(ctx)

	runtime.OnFileDrop(ctx, func(_ int, _ int, paths []string) {
		mdPaths := make([]string, 0, len(paths))
		for _, path := range paths {
			if strings.EqualFold(filepath.Ext(path), ".md") {
				mdPaths = append(mdPaths, path)
			}
		}
		if len(mdPaths) == 0 {
			return
		}
		a.log.InfoFields("Files dropped, opening directly", logger.LogFields{"count": len(mdPaths)})
		for _, path := range mdPaths {
			if allowed := a.allowFile(path); allowed != "" {
				a.log.InfoFields("Emitting file:open", logger.LogFields{"fileName": filepath.Base(allowed)})
				runtime.EventsEmit(ctx, "file:open", allowed)
			} else {
				a.log.ErrorFields("Failed to allow file", logger.LogFields{"fileName": filepath.Base(path)})
			}
		}
	})

	if a.startupFilePath != "" {
		if !isMarkdownPath(a.startupFilePath) {
			a.log.ErrorFields("Ignoring unsupported startup file", logger.LogFields{
				"fileName": filepath.Base(a.startupFilePath),
			})
			return
		}
		// The file was passed to us by the OS (e.g. "open with"), so it is a
		// genuine user choice. Authorize it for ReadLocalFile/WriteLocalFile.
		allowed := a.allowFile(a.startupFilePath)
		if allowed == "" {
			return
		}
		a.log.InfoFields("Emitting file:open event", logger.LogFields{
			"fileName": filepath.Base(allowed),
		})
		runtime.EventsEmit(ctx, "file:open", allowed)
	}
}

// shutdown cleans up resources before application exit.
func (a *App) shutdown(ctx context.Context) {
	a.ssh.Shutdown()
	a.local.Shutdown()
	a.net.StopAll()
	uptime := time.Duration(0)
	if !a.startedAt.IsZero() {
		uptime = time.Since(a.startedAt)
	}
	a.log.InfoFields("gxShell stopped", logger.LogFields{
		"uptime": uptime.String(),
	})
}

// handleSecondInstanceLaunch runs when the user starts gxShell again while an
// instance is already running (for example by double-clicking a .md file). The
// single-instance lock forwards the new process's arguments here instead of
// opening a second window. We bring the existing window to the front and, if an
// argument is a markdown file, open it in a tab via the same trusted path used
// for startup files.
func (a *App) handleSecondInstanceLaunch(args []string) {
	if a.ctx == nil {
		return
	}
	runtime.WindowShow(a.ctx)
	runtime.WindowUnminimise(a.ctx)

	for _, arg := range args {
		if !isMarkdownPath(arg) {
			continue
		}
		// The path came from an OS "open with"/double-click, so it is a genuine
		// user choice; authorize it for ReadLocalFile/WriteLocalFile.
		allowed := a.allowFile(arg)
		if allowed == "" {
			continue
		}
		a.log.InfoFields("Second instance opened file", logger.LogFields{"fileName": filepath.Base(allowed)})
		runtime.EventsEmit(a.ctx, "file:open", allowed)
	}
}

func (a *App) confirmOpenDroppedMarkdown(paths []string) bool {
	if a.ctx == nil {
		return false
	}
	message := ""
	if len(paths) == 1 {
		message = fmt.Sprintf("Open this dropped Markdown file?\n\n%s", paths[0])
	} else {
		shown := paths
		suffix := ""
		if len(paths) > 5 {
			shown = paths[:5]
			suffix = fmt.Sprintf("\n...and %d more", len(paths)-len(shown))
		}
		message = fmt.Sprintf("Open these %d dropped Markdown files?\n\n%s%s", len(paths), strings.Join(shown, "\n"), suffix)
	}
	res, err := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         "Open Markdown file",
		Message:       truncate(message, 1200),
		Buttons:       []string{"Open", "Cancel"},
		DefaultButton: "Cancel",
		CancelButton:  "Cancel",
	})
	if err != nil {
		a.log.ErrorFields("Markdown drop confirm dialog failed", logger.LogFields{"error": err.Error()})
		return false
	}
	a.log.InfoFields("Dialog result", logger.LogFields{"result": res})
	// Windows MessageDialog with QuestionDialog type returns "Yes"/"No" instead of custom button text
	return res == "Open" || res == "Yes"
}

// migrateSecrets migrates plaintext passwords to secure storage.
func (a *App) migrateSecrets() {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return
	}
	changed := false
	for i := range profiles {
		if profiles[i].RememberPassword && (profiles[i].Password != "" || profiles[i].PrivateKeyPassphrase != "") {
			if err := a.saveProfileSecrets(&profiles[i]); err == nil {
				changed = true
			}
		}
		if !profiles[i].RememberPassword && (profiles[i].Password != "" || profiles[i].PrivateKeyPassphrase != "") {
			profiles[i].Password = ""
			profiles[i].PrivateKeyPassphrase = ""
			changed = true
		}
	}
	if changed {
		_ = a.store.SaveProfiles(profiles)
	}
	a.store.CleanupBackups()
}

// migrateCliProfileFlags moves opt-in values written by older versions under the
// "aiEnabled"/"aiAlias" JSON keys into the current CliEnabled/CliAlias fields,
// then clears the legacy fields so they are not written back. It is a one-time,
// idempotent migration: once profiles are re-saved without the legacy keys it
// becomes a no-op.
func (a *App) migrateCliProfileFlags() {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return
	}
	changed := false
	for i := range profiles {
		p := &profiles[i]
		if p.LegacyAIEnabled && !p.CliEnabled {
			p.CliEnabled = true
			changed = true
		}
		if p.LegacyAIAlias != "" && p.CliAlias == "" {
			p.CliAlias = p.LegacyAIAlias
			changed = true
		}
		if p.LegacyAIEnabled || p.LegacyAIAlias != "" {
			p.LegacyAIEnabled = false
			p.LegacyAIAlias = ""
			changed = true
		}
	}
	if changed {
		_ = a.store.SaveProfiles(profiles)
	}
}

var dangerousCmdPatterns = []struct {
	pattern string
	reason  string
}{
	{`rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|/)`, "destructive rm command"},
	{`mkfs`, "filesystem format"},
	{`dd\s+`, "raw disk write"},
	{`:\(\)\{\s*:\|:\&\s*\}\s*;`, "fork bomb"},
	{`>\s*/dev/sd`, "direct disk write"},
	{`chmod\s+(-R\s+)?0?777\s+/`, "overly permissive chmod on root"},
	{`shutdown`, "system shutdown"},
	{`reboot`, "system reboot"},
	{`init\s+[06]`, "init to runlevel 0/6"},
	{`systemctl\s+(stop|disable)\s+(ssh|sshd|network|systemd)`, "stopping critical services"},
	{`iptables\s+-F`, "flushing firewall rules"},
	{`crontab\s+-r`, "removing crontab"},
	{`userdel`, "deleting user"},
	{`passwd\s+root`, "changing root password"},
	{`mv\s+.*\s*/dev/null`, "moving files to /dev/null"},
}

var dangerousCmdRegexps = sync.OnceValue(func() []struct {
	*regexp.Regexp
	reason string
} {
	result := make([]struct {
		*regexp.Regexp
		reason string
	}, len(dangerousCmdPatterns))
	for i, p := range dangerousCmdPatterns {
		result[i].Regexp = regexp.MustCompile(p.pattern)
		result[i].reason = p.reason
	}
	return result
})

// checkDangerousCommand validates if a command is safe to execute.
func checkDangerousCommand(cmd string) (string, bool) {
	trimmed := strings.TrimSpace(cmd)
	base := trimmed
	if idx := strings.Index(trimmed, " "); idx > 0 {
		base = trimmed[:idx]
	}
	directDangerous := map[string]string{
		"mkfs": "filesystem format", "shutdown": "system shutdown", "reboot": "system reboot",
		"userdel": "deleting user", "fdisk": "disk partitioning",
	}
	if reason, ok := directDangerous[base]; ok {
		return reason, true
	}
	for _, dr := range dangerousCmdRegexps() {
		if dr.MatchString(cmd) {
			return dr.reason, true
		}
	}
	return "", false
}

var sensitivePaths = []struct {
	pattern string
	reason  string
}{
	{"/etc/shadow", "password hashes"},
	{"/etc/gshadow", "group password hashes"},
	{"/etc/ssh/ssh_host_", "SSH private host keys"},
	{"/root/.ssh/id_", "SSH private keys"},
	{"/home/", "user home SSH private keys"},
}

// checkSensitivePath validates if a path contains sensitive files. The input may
// be a full shell command, so it checks a few conservative normalizations to
// catch common shell/path obfuscation such as /etc//shadow, /etc/../etc/shadow,
// quoted path fragments, and backslash-escaped characters.
func checkSensitivePath(p string) (string, bool) {
	for _, candidate := range sensitivePathCandidates(p) {
		lower := strings.ToLower(normalizeSensitivePathText(candidate))
		for _, sp := range sensitivePaths {
			pattern := strings.ToLower(sp.pattern)
			if pattern == "/home/" {
				if containsPrivateSSHKeyReference(lower) {
					return sp.reason, true
				}
				continue
			}
			if strings.Contains(lower, pattern) {
				return sp.reason, true
			}
		}
	}
	return "", false
}

func sensitivePathCandidates(input string) []string {
	stripped := stripShellPathObfuscation(input)
	candidates := []string{input, stripped}
	for _, field := range strings.Fields(stripped) {
		candidates = append(candidates, field)
		if cleaned := cleanRemotePathToken(field); cleaned != "" {
			candidates = append(candidates, cleaned)
		}
	}
	return candidates
}

func stripShellPathObfuscation(s string) string {
	replacer := strings.NewReplacer("'", "", `"`, "", `\`, "")
	return replacer.Replace(s)
}

func normalizeSensitivePathText(s string) string {
	for strings.Contains(s, "//") {
		s = strings.ReplaceAll(s, "//", "/")
	}
	for strings.Contains(s, "/./") {
		s = strings.ReplaceAll(s, "/./", "/")
	}
	return s
}

func cleanRemotePathToken(token string) string {
	token = normalizeSensitivePathText(token)
	if token == "" {
		return ""
	}
	if strings.HasPrefix(token, "~/") {
		return path.Clean("/home/__self__/" + strings.TrimPrefix(token, "~/"))
	}
	if strings.HasPrefix(token, "~root/") {
		return path.Clean("/root/" + strings.TrimPrefix(token, "~root/"))
	}
	if strings.HasPrefix(token, "~") {
		if slash := strings.Index(token, "/"); slash > 1 {
			return path.Clean("/home/" + token[1:])
		}
	}
	if strings.HasPrefix(token, "/") {
		return path.Clean(token)
	}
	return ""
}

func containsPrivateSSHKeyReference(lower string) bool {
	for _, field := range strings.Fields(lower) {
		field = normalizeSensitivePathText(field)
		if strings.Contains(field, "/.ssh/id_") && !strings.HasSuffix(field, ".pub") {
			return true
		}
	}
	return false
}

// readOnlyCommands lists binaries that only inspect state. A command whose
// program name is in this set is allowed to run without an explicit human
// confirmation when the caller explicitly allows the read-only shortcut. The
// set is intentionally conservative: shell operators, quoting, expansion, and
// globbing are rejected separately by isReadOnlyCommand, so each entry only
// needs to be safe as a standalone command with literal arguments. Every entry
// here must be unable to mutate state OR execute another program even when
// given arbitrary flags. Commands with a known mutating flag (date -s, ss -K,
// dmesg -C, hostname NAME, sort -o, sed -i, find -exec) and command wrappers
// (env, command, xargs, sudo, watch, timeout, awk, sed, sh, ...) are deliberately
// excluded so they fall through to confirmation.
var readOnlyCommands = map[string]struct{}{
	"echo": {},
	// File content inspection
	"cat": {}, "tac": {}, "nl": {}, "head": {}, "tail": {}, "wc": {},
	"cksum": {}, "md5sum": {}, "sha1sum": {}, "sha256sum": {}, "sha512sum": {}, "zcat": {},
	// Read-only text search
	"grep": {}, "egrep": {}, "fgrep": {}, "zgrep": {},
	// Filesystem inspection
	"ls": {}, "pwd": {}, "df": {}, "du": {}, "stat": {}, "file": {},
	"realpath": {}, "readlink": {}, "basename": {}, "dirname": {}, "tree": {},
	// Process / network / environment inspection
	"ps": {}, "pgrep": {}, "pstree": {}, "lsof": {}, "netstat": {}, "getent": {}, "printenv": {},
	// System / identity info
	"uptime": {}, "uname": {}, "whoami": {}, "id": {}, "arch": {}, "nproc": {},
	"w": {}, "who": {}, "last": {}, "groups": {},
	"lscpu": {}, "lsblk": {}, "lsusb": {}, "lspci": {}, "free": {}, "vmstat": {}, "iostat": {}, "mpstat": {},
	// Locators
	"which": {}, "whereis": {}, "type": {},
}

// isReadOnlyCommand reports whether cmd is a single read-only command that may
// run without a confirmation prompt. It is deliberately conservative: any shell
// metacharacter that could chain, redirect, background or substitute commands
// disqualifies the command (returning false), as does an environment-assignment
// prefix or a program name that is not on the read-only allowlist. A false
// result is always safe because it only means the caller must confirm.
func isReadOnlyCommand(cmd string) bool {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return false
	}
	// Reject anything that can chain, redirect, background, substitute, quote,
	// escape, expand paths, or glob. That is stricter than a shell parser, but
	// false only means the caller asks for confirmation.
	if strings.ContainsAny(trimmed, ";|&<>`$\\'\"~*?[]{}\n\r") {
		return false
	}
	first := strings.Fields(trimmed)[0]
	// Reject an environment-assignment prefix such as `FOO=bar cmd`.
	if strings.Contains(first, "=") {
		return false
	}
	// Strip any leading path (remote paths are always unix-style, so split on
	// '/' rather than using filepath which would use the host separator).
	base := first
	if idx := strings.LastIndex(base, "/"); idx >= 0 {
		base = base[idx+1:]
	}
	_, ok := readOnlyCommands[base]
	return ok
}

// guardCommand applies the shared pre-execution safety policy used by both the
// in-app AI assistant and the external CLI: the dangerous-command and
// sensitive-path blocklists, then a human confirmation gate. When
// allowReadOnlyWithoutConfirm is true, commands on the read-only allowlist skip
// confirmation; every other command requires confirm() to return true. confirm
// must be backed by a native dialog the renderer cannot forge. It returns
// ok=true when the command may run; when ok=false, reason is a short
// human-readable explanation (a blocklist hit or a declined prompt).
//
// Ordering matters: the sensitive-path check runs before the read-only check so
// that, e.g., `cat /etc/shadow` is blocked rather than waved through as a read.
func guardCommand(command string, allowReadOnlyWithoutConfirm bool, confirm func() bool) (reason string, ok bool) {
	if warn, blocked := checkDangerousCommand(command); blocked {
		return warn, false
	}
	if warn, blocked := checkSensitivePath(command); blocked {
		return warn, false
	}
	if allowReadOnlyWithoutConfirm && isReadOnlyCommand(command) {
		return "", true
	}
	if !confirm() {
		return "user declined execution", false
	}
	return "", true
}
