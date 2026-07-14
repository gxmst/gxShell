package main

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
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
	ctx     context.Context
	store   *config.Store
	log     *logger.Logger
	ssh     *sshmanager.Manager
	sftp    *sftpmanager.Manager
	monitor *monitor.Manager
	secrets *secrets.Store
	net     *network.Manager
	tunnels *tunnel.Manager
	ai      *ai.Manager
	docker  *docker.Manager
	local   *localterm.Manager
	// automationEventFn is a test seam for terminal activity events. Production
	// leaves it nil and emitTerminalAutomation forwards events through Wails.
	automationEventFn func(terminalAutomationEvent)
	// cliSessionEventFn is the equivalent seam for announcing the SSH session
	// selected by an external CLI request so the frontend can ensure it has a
	// visible terminal tab before automation output is mirrored.
	cliSessionEventFn func(types.SessionInfo)
	nativeDialogMu    sync.Mutex
	// aiTools is the trust ledger of backend-authorized AI tool calls awaiting a
	// native confirmation + execution. See aiToolRegistry.
	aiTools       *aiToolRegistry
	cliMu         sync.Mutex
	cliConnecting map[string]*cliConnectCall
	cliSessionMu  sync.Mutex
	// cliPreferredSessions pins each profile to one connected session. Without
	// this, iterating the SSH manager's map can select a different session on
	// every request when the same profile has multiple connections.
	cliPreferredSessions map[string]string
	cliApprovalMu        sync.Mutex
	cliApprovals         map[string]*cliApprovalBatch
	// cliApprovalDelay overrides the batch-coalescing window; zero means the
	// cliApprovalDelay const is used. cliConfirmBatchFn overrides the native
	// confirmation dialog; nil means the real MessageDialog is used. Both are
	// seams for tests to exercise the batching logic without a GUI.
	cliApprovalDelay  time.Duration
	cliConfirmBatchFn func(serverName string, commands []string) bool
	cliServer         *http.Server
	rateLimiter       *connectionRateLimiter
	startupFilePath   string
	startedAt         time.Time
	// allowedFiles tracks the local file paths the user has genuinely chosen to
	// open. ReadLocalFile/WriteLocalFile only operate on paths in this set, so a
	// compromised renderer cannot use them to read or overwrite arbitrary files
	// on disk. See allowedFileSet.
	allowedFiles *allowedFileSet
	// kiRequests holds pending keyboard-interactive prompts awaiting the user's
	// answers from the frontend dialog. See app_auth.go.
	kiRequests *kiRegistry
	// pendingOpenFile holds a startup/second-instance text file that has been
	// authorized but may have been emitted before the frontend registered its
	// file:open listener. The frontend pulls it once on mount via GetStartupFile
	// so a first launch that lost the pushed event still opens the file.
	pendingOpenMu   sync.Mutex
	pendingOpenFile string
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
	a := &App{
		rateLimiter:          newConnectionRateLimiter(),
		allowedFiles:         newAllowedFileSet(),
		kiRequests:           newKiRegistry(),
		cliConnecting:        map[string]*cliConnectCall{},
		cliPreferredSessions: map[string]string{},
		cliApprovals:         map[string]*cliApprovalBatch{},
	}
	// The logger is not created until startup, so the collision callback reads
	// a.log lazily and stays silent until it exists.
	a.aiTools = newAiToolRegistry(aiToolAuthorizationTTL, func(sessionID, toolCallID, toolName string) {
		if a.log == nil {
			return
		}
		a.log.ErrorFields("AI tool ID collision detected", LogFields{
			"session":    sessionID,
			"toolCallID": toolCallID,
			"toolName":   toolName,
		})
	})
	return a
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
		a.nativeDialogMu.Lock()
		defer a.nativeDialogMu.Unlock()
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

	// Cross-subsystem cleanup must follow EVERY disconnect path, not only the
	// user-initiated App.Disconnect: a server-initiated drop (shell exit,
	// keepalive failure) otherwise leaks the monitor poller and keeps tunnel
	// listeners bound, so the auto-reconnected session cannot rebind its
	// tunnels (address already in use) until the app restarts.
	a.ssh.SetOnClosed(func(sessionID string) {
		a.monitor.Stop(sessionID)
		a.sftp.InvalidateClient(sessionID)
		a.tunnels.StopTunnels(sessionID)
		a.net.StopPing(sessionID)
		a.discardAuthorizedAiToolCalls(sessionID)
	})
	a.ssh.SetKeyboardInteractivePrompt(a.handleKeyboardInteractive)
	a.ssh.SetHostKeyChangeConfirm(a.confirmHostKeyChange)

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

	preserveSecretIDs := a.migrateSecrets()
	a.migrateCliProfileFlags(preserveSecretIDs)
	a.store.MigrateSettingsDefaults()
	a.store.MigrateCommandDefaults()
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
		textPaths := make([]string, 0, len(paths))
		for _, path := range paths {
			if isSupportedTextPath(path) {
				textPaths = append(textPaths, path)
			}
		}
		if len(textPaths) == 0 {
			return
		}
		if !a.confirmOpenDroppedTextFiles(textPaths) {
			a.log.Info("User cancelled dropped text-file open")
			return
		}
		a.log.InfoFields("Files dropped, opening after confirm", logger.LogFields{"count": len(textPaths)})
		for _, path := range textPaths {
			if allowed := a.allowFile(path); allowed != "" {
				a.log.InfoFields("Emitting file:open", logger.LogFields{"fileName": filepath.Base(allowed)})
				runtime.EventsEmit(ctx, "file:open", allowed)
			} else {
				a.log.ErrorFields("Failed to allow file", logger.LogFields{"fileName": filepath.Base(path)})
			}
		}
	})

	if a.startupFilePath != "" {
		if !isSupportedTextPath(a.startupFilePath) {
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
		// Stash the file rather than emitting file:open here. On first launch this
		// domReady runs before React registers its file:open listener, so a pushed
		// event would be lost (the app opened but the document did not). The
		// frontend pulls this via GetStartupFile once its listener is ready. Not
		// emitting also avoids a double-open if the listener happened to be ready.
		a.log.InfoFields("Stashing startup file for frontend pull", logger.LogFields{
			"fileName": filepath.Base(allowed),
		})
		a.setPendingOpenFile(allowed)
	}
}

// setPendingOpenFile stores an authorized text file awaiting a frontend that may
// not have registered its file:open listener yet.
func (a *App) setPendingOpenFile(path string) {
	a.pendingOpenMu.Lock()
	a.pendingOpenFile = path
	a.pendingOpenMu.Unlock()
}

// GetStartupFile returns and clears any pending startup/second-instance text
// file. The frontend calls this once after it has registered its file:open
// listener, which closes the race where the pushed file:open event fired before
// the listener existed (first launch opened the app but not the document).
func (a *App) GetStartupFile() string {
	a.pendingOpenMu.Lock()
	defer a.pendingOpenMu.Unlock()
	path := a.pendingOpenFile
	a.pendingOpenFile = ""
	return path
}

// shutdown cleans up resources before application exit.
func (a *App) shutdown(ctx context.Context) {
	if a.cliServer != nil {
		shutdownCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		_ = a.cliServer.Shutdown(shutdownCtx)
		cancel()
	}
	// startup may quit early when the config directory cannot be initialized.
	// Wails still invokes shutdown in that case, so every subsystem must be
	// treated as optional until startup has completed successfully.
	if a.ssh != nil {
		a.ssh.Shutdown()
	}
	if a.local != nil {
		a.local.Shutdown()
	}
	if a.net != nil {
		a.net.StopAll()
	}
	uptime := time.Duration(0)
	if !a.startedAt.IsZero() {
		uptime = time.Since(a.startedAt)
	}
	if a.log != nil {
		a.log.InfoFields("gxShell stopped", logger.LogFields{
			"uptime": uptime.String(),
		})
	}
}

// handleSecondInstanceLaunch runs when the user starts gxShell again while an
// instance is already running (for example by double-clicking a .md file). The
// single-instance lock forwards the new process's arguments here instead of
// opening a second window. We bring the existing window to the front and, if an
// argument is a supported text file, open it in a tab via the same trusted path used
// for startup files.
func (a *App) handleSecondInstanceLaunch(args []string) {
	if a.ctx == nil {
		return
	}
	runtime.WindowShow(a.ctx)
	runtime.WindowUnminimise(a.ctx)

	for _, arg := range args {
		if !isSupportedTextPath(arg) {
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

func (a *App) confirmOpenDroppedTextFiles(paths []string) bool {
	if a.ctx == nil {
		return false
	}
	a.nativeDialogMu.Lock()
	defer a.nativeDialogMu.Unlock()
	message := ""
	if len(paths) == 1 {
		message = fmt.Sprintf("Open this dropped text file?\n\n%s", paths[0])
	} else {
		shown := paths
		suffix := ""
		if len(paths) > 5 {
			shown = paths[:5]
			suffix = fmt.Sprintf("\n...and %d more", len(paths)-len(shown))
		}
		message = fmt.Sprintf("Open these %d dropped text files?\n\n%s%s", len(paths), strings.Join(shown, "\n"), suffix)
	}
	res, err := runtime.MessageDialog(a.ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         "Open text file",
		Message:       truncate(message, 1200),
		Buttons:       []string{"Open", "Cancel"},
		DefaultButton: "Cancel",
		CancelButton:  "Cancel",
	})
	if err != nil {
		a.log.ErrorFields("Text-file drop confirm dialog failed", logger.LogFields{"error": err.Error()})
		return false
	}
	a.log.InfoFields("Dialog result", logger.LogFields{"result": res})
	// Windows MessageDialog with QuestionDialog type returns "Yes"/"No" instead of custom button text
	return res == "Open" || res == "Yes"
}

// migrateSecrets migrates plaintext passwords to secure storage. It returns the
// IDs of profiles whose plaintext credentials had to remain in profiles.json
// because secure storage failed, so later startup migrations do not wipe them.
func (a *App) migrateSecrets() map[string]bool {
	profiles, err := a.store.ListProfiles()
	if err != nil {
		return nil
	}
	changed := false
	preserveSecretIDs := map[string]bool{}
	for i := range profiles {
		p := &profiles[i]
		if p.RememberPassword && (p.Password != "" || p.PrivateKeyPassphrase != "") {
			pw, pp := p.Password, p.PrivateKeyPassphrase
			saveErr := a.secrets.SavePassword(p.ID, pw)
			if saveErr == nil && pp != "" {
				saveErr = a.secrets.SavePassphrase(p.ID, pp)
			}
			if saveErr == nil {
				p.Password = ""
				p.PrivateKeyPassphrase = ""
				changed = true
			} else {
				// Keep plaintext in p so it is persisted for retry.
				preserveSecretIDs[p.ID] = true
				a.log.ErrorFields("secret migration failed; plaintext retained on disk for retry", logger.LogFields{
					"profileId": p.ID, "error": saveErr.Error(),
				})
			}
		}
		if !p.RememberPassword && (p.Password != "" || p.PrivateKeyPassphrase != "") {
			p.Password = ""
			p.PrivateKeyPassphrase = ""
			changed = true
		}
	}
	if changed {
		_ = a.store.SaveProfilesPreservingSecrets(profiles, preserveSecretIDs)
	}
	a.store.CleanupBackups()
	if len(preserveSecretIDs) == 0 {
		return nil
	}
	return preserveSecretIDs
}

// migrateCliProfileFlags moves opt-in values written by older versions under the
// "aiEnabled"/"aiAlias" JSON keys into the current CliEnabled/CliAlias fields,
// then clears the legacy fields so they are not written back. It is a one-time,
// idempotent migration: once profiles are re-saved without the legacy keys it
// becomes a no-op.
func (a *App) migrateCliProfileFlags(preserveSecretIDs ...map[string]bool) {
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
		var preserve map[string]bool
		if len(preserveSecretIDs) > 0 {
			preserve = preserveSecretIDs[0]
		}
		_ = a.store.SaveProfilesPreservingSecrets(profiles, preserve)
	}
}
