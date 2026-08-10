package app

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"gxShell/backend/logger"
	sftpmanager "gxShell/backend/sftp"
	"gxShell/backend/types"
)

type cliTunnelRecord struct {
	ID        string
	Alias     string
	SessionID string
	Rule      types.TunnelRule
}

type cliTransferRequest struct {
	Operation  string `json:"operation"`
	Server     string `json:"server"`
	LocalPath  string `json:"localPath"`
	RemotePath string `json:"remotePath"`
	Overwrite  bool   `json:"overwrite,omitempty"`
	Mkdir      bool   `json:"mkdir,omitempty"`
}

// handleCliTransfer moves one local regular file through the GUI's native SFTP
// client. The operation deliberately does not use profile trust windows:
// every local path is shown in a native approval dialog before any connection
// or remote write is started.
func (a *App) handleCliTransfer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeCliError(w, http.StatusMethodNotAllowed, "validation", "method not allowed")
		return
	}
	var req cliTransferRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, cliMaxRequestSize))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeCliError(w, http.StatusBadRequest, "validation", "invalid request body: "+err.Error())
		return
	}
	req.Operation = strings.ToLower(strings.TrimSpace(req.Operation))
	req.Server = strings.TrimSpace(req.Server)
	req.RemotePath = strings.TrimSpace(req.RemotePath)
	if req.Operation != "push" && req.Operation != "pull" {
		writeCliError(w, http.StatusBadRequest, "validation", "operation must be push or pull")
		return
	}
	if req.Server == "" || req.RemotePath == "" || strings.ContainsRune(req.RemotePath, '\x00') {
		writeCliError(w, http.StatusBadRequest, "validation", "server and remotePath are required")
		return
	}
	cleanRemote := path.Clean(req.RemotePath)
	if cleanRemote == "." || cleanRemote == "/" {
		writeCliError(w, http.StatusBadRequest, "validation", "remotePath must name a file")
		return
	}
	if req.Mkdir && req.Operation != "push" {
		writeCliError(w, http.StatusBadRequest, "validation", "mkdir is only valid for push")
		return
	}
	localPath, err := normalizeCliTransferLocalPath(req.LocalPath, req.Operation == "push")
	if err != nil {
		writeCliError(w, http.StatusBadRequest, "validation", err.Error())
		return
	}
	if block, blocked := checkCliTransferSensitivePath(req.RemotePath); blocked {
		writeCliJSON(w, http.StatusForbidden, map[string]any{
			"error": "BLOCKED: " + block.Message(), "errorKind": "blocked", "blocked": true,
			"blockedBy": block.Kind, "reason": block.Reason, "detail": block.Detail,
			"outcome": "blocked",
		})
		return
	}

	profile, err := a.findCliProfile(req.Server)
	if err != nil {
		writeCliError(w, http.StatusNotFound, "daemon", err.Error())
		return
	}
	alias := cliProfileName(profile)
	destination := alias + ":" + req.RemotePath
	source := localPath
	if req.Operation == "pull" {
		source, destination = destination, localPath
	}
	description := fmt.Sprintf("Transfer local file %s to %s (atomic, no overwrite by default)", localPath, destination)
	if req.Operation == "pull" {
		description = fmt.Sprintf("Transfer remote file %s to local file %s (atomic, no overwrite by default)", source, destination)
	}
	if req.Overwrite {
		description += "; allow replacing an existing destination"
	}
	if req.Mkdir {
		description += "; create missing remote parent directories"
	}
	// Unlike remote command execution and remote-to-remote copy, a local file
	// transfer must always go through the native approval dialog, even when the
	// profile has an active CLI trust window.
	if !a.confirmCliExecution(alias, description) {
		writeCliJSON(w, http.StatusForbidden, map[string]any{
			"error": "user declined local file transfer", "errorKind": "blocked",
			"blocked": true, "blockedBy": "user-approval", "outcome": "blocked",
		})
		return
	}
	if a.sftp == nil || a.ssh == nil {
		writeCliError(w, http.StatusBadGateway, "daemon", "SFTP is unavailable")
		return
	}
	sessionID, _, err := a.cliSessionForProfile(profile.ID)
	if err != nil {
		writeCliError(w, http.StatusBadGateway, "connect", "failed to connect: "+err.Error())
		return
	}
	a.announceCliSession(sessionID)

	overwritten := false
	var bytes int64
	if req.Operation == "push" {
		info, statErr := os.Stat(localPath)
		if statErr != nil || !info.Mode().IsRegular() {
			if statErr != nil {
				writeCliError(w, http.StatusBadRequest, "validation", "local source is no longer available: "+statErr.Error())
			} else {
				writeCliError(w, http.StatusBadRequest, "validation", "local source is not a regular file")
			}
			return
		}
		bytes = info.Size()
		if req.Mkdir {
			parent := path.Dir(cleanRemote)
			if parent != "." && parent != "/" {
				if err := a.sftp.CreateRemoteDir(sessionID, parent); err != nil {
					writeCliError(w, http.StatusBadGateway, "sftp", "create remote parent directory: "+err.Error())
					return
				}
			}
		}
		exists, statErr := a.sftp.RemoteFileExists(sessionID, req.RemotePath)
		if statErr != nil {
			writeCliError(w, http.StatusBadGateway, "sftp", statErr.Error())
			return
		}
		if exists {
			overwritten = req.Overwrite
			if !req.Overwrite {
				writeCliTransferConflict(w, destination, true)
				return
			}
		}
		err = a.sftp.UploadFileWithPolicy(sessionID, localPath, req.RemotePath, req.Overwrite)
	} else {
		if info, statErr := os.Lstat(localPath); statErr == nil {
			if !info.Mode().IsRegular() {
				writeCliError(w, http.StatusBadRequest, "validation", "local destination is not a regular file")
				return
			}
			overwritten = true
			if !req.Overwrite {
				writeCliTransferConflict(w, destination, false)
				return
			}
		} else if !os.IsNotExist(statErr) {
			writeCliError(w, http.StatusBadRequest, "validation", "inspect local destination: "+statErr.Error())
			return
		}
		err = a.sftp.DownloadFileWithPolicy(sessionID, req.RemotePath, localPath, req.Overwrite)
		if err == nil {
			if info, statErr := os.Stat(localPath); statErr == nil {
				bytes = info.Size()
			}
		}
	}
	if err != nil {
		if sftpmanager.IsOverwriteRequired(err) {
			writeCliTransferConflict(w, destination, req.Operation == "push")
			return
		}
		writeCliError(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	writeCliJSON(w, http.StatusOK, map[string]any{
		"outcome": "succeeded", "operation": req.Operation, "server": alias,
		"source": source, "destination": destination, "bytes": bytes,
		"overwritten": overwritten, "atomic": true,
	})
}

// checkCliTransferSensitivePath applies the command guard to both absolute and
// relative remote spellings. SFTP accepts paths relative to the server's
// working directory, so a relative `etc/shadow` or `../etc/shadow` must not be
// allowed to bypass the absolute-path blocklist.
func checkCliTransferSensitivePath(remotePath string) (commandBlock, bool) {
	if block, blocked := checkSensitivePathBlock(remotePath); blocked {
		return block, true
	}
	cleaned := path.Clean(remotePath)
	if cleaned == "." || strings.HasPrefix(cleaned, "/") || strings.HasPrefix(cleaned, "~") {
		return commandBlock{}, false
	}
	return checkSensitivePathBlock("/" + cleaned)
}

func normalizeCliTransferLocalPath(value string, source bool) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsRune(value, '\x00') {
		return "", fmt.Errorf("local path is required")
	}
	abs, err := filepath.Abs(value)
	if err != nil {
		return "", fmt.Errorf("invalid local path: %w", err)
	}
	abs = filepath.Clean(abs)
	if source {
		info, statErr := os.Stat(abs)
		if statErr != nil {
			return "", fmt.Errorf("local source is not available: %w", statErr)
		}
		if !info.Mode().IsRegular() {
			return "", fmt.Errorf("local source must be a regular file")
		}
		return abs, nil
	}
	if info, statErr := os.Lstat(abs); statErr == nil {
		if !info.Mode().IsRegular() {
			return "", fmt.Errorf("local destination must be a regular file")
		}
	} else if !os.IsNotExist(statErr) {
		return "", fmt.Errorf("inspect local destination: %w", statErr)
	}
	parentInfo, parentErr := os.Stat(filepath.Dir(abs))
	if parentErr != nil {
		return "", fmt.Errorf("local destination directory is not available: %w", parentErr)
	}
	if !parentInfo.IsDir() {
		return "", fmt.Errorf("local destination parent is not a directory")
	}
	return abs, nil
}

func writeCliTransferConflict(w http.ResponseWriter, destination string, remote bool) {
	detail := "destination already exists"
	if remote {
		detail = "remote destination already exists"
	}
	writeCliJSON(w, http.StatusConflict, map[string]any{
		"error": "destination exists; pass --overwrite to replace it", "errorKind": "overwrite_required",
		"outcome": "blocked", "blocked": true, "blockedBy": "overwrite-policy",
		"reason": "destination already exists", "detail": detail + ": " + destination,
		"overwriteRequired": true,
	})
}

func (a *App) handleCliCopy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeCliError(w, http.StatusMethodNotAllowed, "validation", "method not allowed")
		return
	}
	var req struct {
		SourceServer      string `json:"sourceServer"`
		SourcePath        string `json:"sourcePath"`
		DestinationServer string `json:"destinationServer"`
		DestinationPath   string `json:"destinationPath"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, cliMaxRequestSize))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeCliError(w, http.StatusBadRequest, "validation", "invalid request body: "+err.Error())
		return
	}
	req.SourceServer = strings.TrimSpace(req.SourceServer)
	req.SourcePath = strings.TrimSpace(req.SourcePath)
	req.DestinationServer = strings.TrimSpace(req.DestinationServer)
	req.DestinationPath = strings.TrimSpace(req.DestinationPath)
	if req.SourceServer == "" || req.SourcePath == "" || req.DestinationServer == "" || req.DestinationPath == "" {
		writeCliError(w, http.StatusBadRequest, "validation", "source and destination server:path values are required")
		return
	}
	for _, candidate := range []string{req.SourcePath, req.DestinationPath} {
		if block, blocked := checkSensitivePathBlock(candidate); blocked {
			writeCliJSON(w, http.StatusForbidden, map[string]any{
				"error": "BLOCKED: " + block.Message(), "errorKind": "blocked", "blocked": true,
				"blockedBy": block.Kind, "reason": block.Reason, "detail": block.Detail,
			})
			return
		}
	}

	sourceProfile, err := a.findCliProfile(req.SourceServer)
	if err != nil {
		writeCliError(w, http.StatusNotFound, "daemon", err.Error())
		return
	}
	destinationProfile, err := a.findCliProfile(req.DestinationServer)
	if err != nil {
		writeCliError(w, http.StatusNotFound, "daemon", err.Error())
		return
	}
	sourceAlias := cliProfileName(sourceProfile)
	destinationAlias := cliProfileName(destinationProfile)
	approval := fmt.Sprintf("Copy remote file %s:%s to %s:%s (atomic destination write and SHA-256 verification)", sourceAlias, req.SourcePath, destinationAlias, req.DestinationPath)
	decision := a.authorizeCliCopy(sourceProfile, destinationProfile, approval)
	if !decision.Allowed {
		writeCliError(w, http.StatusForbidden, "blocked", "user declined remote file copy")
		return
	}
	if a.log != nil {
		a.log.InfoFields("CLI copying remote file", logger.LogFields{
			"source": sourceAlias, "destination": destinationAlias, "approval": decision.Source,
		})
	}

	sourceSession, _, err := a.cliSessionForProfile(sourceProfile.ID)
	if err != nil {
		writeCliError(w, http.StatusBadGateway, "connect", "failed to connect source: "+err.Error())
		return
	}
	destinationSession, _, err := a.cliSessionForProfile(destinationProfile.ID)
	if err != nil {
		writeCliError(w, http.StatusBadGateway, "connect", "failed to connect destination: "+err.Error())
		return
	}
	a.announceCliSession(sourceSession)
	a.announceCliSession(destinationSession)
	result, err := a.sftp.CopyRemoteFile(r.Context(), sourceSession, req.SourcePath, destinationSession, req.DestinationPath, nil)
	if err != nil {
		writeCliError(w, http.StatusBadGateway, "sftp", err.Error())
		return
	}
	writeCliJSON(w, http.StatusOK, map[string]any{
		"source":      sourceAlias + ":" + req.SourcePath,
		"destination": destinationAlias + ":" + req.DestinationPath,
		"bytes":       result.Bytes, "sha256": result.SHA256, "atomic": true, "verified": true,
	})
}

func (a *App) handleCliTunnels(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		a.openCliTunnel(w, r)
	case http.MethodGet:
		a.listCliTunnels(w)
	case http.MethodDelete:
		a.closeCliTunnel(w, strings.TrimSpace(r.URL.Query().Get("id")))
	default:
		writeCliError(w, http.StatusMethodNotAllowed, "validation", "method not allowed")
	}
}

func (a *App) openCliTunnel(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Server string `json:"server"`
		Type   string `json:"type"`
		Local  string `json:"local"`
		Remote string `json:"remote,omitempty"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, cliMaxRequestSize))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		writeCliError(w, http.StatusBadRequest, "validation", "invalid request body: "+err.Error())
		return
	}
	local, err := normalizeCliLoopbackEndpoint(req.Local)
	if err != nil {
		writeCliError(w, http.StatusBadRequest, "validation", err.Error())
		return
	}
	var tunnelType types.TunnelType
	switch strings.ToLower(strings.TrimSpace(req.Type)) {
	case "local":
		tunnelType = types.TunnelLocal
		if err := validateCliRemoteEndpoint(req.Remote); err != nil {
			writeCliError(w, http.StatusBadRequest, "validation", err.Error())
			return
		}
	case "dynamic", "socks":
		tunnelType = types.TunnelDynamic
		req.Remote = ""
	default:
		writeCliError(w, http.StatusBadRequest, "validation", "tunnel type must be local or dynamic")
		return
	}
	profile, err := a.findCliProfile(strings.TrimSpace(req.Server))
	if err != nil {
		writeCliError(w, http.StatusNotFound, "daemon", err.Error())
		return
	}
	alias := cliProfileName(profile)
	description := fmt.Sprintf("Open temporary SSH %s tunnel on %s via %s", tunnelType, local, alias)
	if tunnelType == types.TunnelLocal {
		description += " to " + req.Remote
	}
	description += ". This loopback listener must be closed immediately after use."
	if !a.confirmCliExecution(alias, description) {
		writeCliError(w, http.StatusForbidden, "blocked", "user declined temporary SSH tunnel")
		return
	}
	sessionID, _, err := a.cliSessionForProfile(profile.ID)
	if err != nil {
		writeCliError(w, http.StatusBadGateway, "connect", "failed to connect: "+err.Error())
		return
	}
	client, err := a.ssh.Client(sessionID)
	if err != nil {
		writeCliError(w, http.StatusBadGateway, "ssh", err.Error())
		return
	}
	id := newCliResourceID("tun")
	rule := types.TunnelRule{ID: id, Type: tunnelType, Local: local, Remote: strings.TrimSpace(req.Remote), BindHost: "127.0.0.1"}
	status := a.tunnels.AddTunnel(sessionID, client, rule)
	if !status.Active {
		writeCliError(w, http.StatusBadGateway, "tunnel", status.Error)
		return
	}
	record := cliTunnelRecord{ID: id, Alias: alias, SessionID: sessionID, Rule: status.Rule}
	a.cliTunnelsMu.Lock()
	a.cliTunnels[id] = record
	a.cliTunnelsMu.Unlock()
	writeCliJSON(w, http.StatusCreated, cliTunnelPayload(record, true, ""))
}

func (a *App) listCliTunnels(w http.ResponseWriter) {
	a.cliTunnelsMu.Lock()
	records := make([]cliTunnelRecord, 0, len(a.cliTunnels))
	for _, record := range a.cliTunnels {
		records = append(records, record)
	}
	a.cliTunnelsMu.Unlock()
	items := make([]map[string]any, 0, len(records))
	for _, record := range records {
		active, errorMessage := false, "tunnel is no longer active"
		for _, status := range a.tunnels.ListStatus(record.SessionID) {
			if status.Rule.ID == record.ID {
				active, errorMessage = status.Active, status.Error
				record.Rule = status.Rule
				break
			}
		}
		items = append(items, cliTunnelPayload(record, active, errorMessage))
	}
	writeCliJSON(w, http.StatusOK, map[string]any{"tunnels": items, "count": len(items)})
}

func (a *App) closeCliTunnel(w http.ResponseWriter, id string) {
	if id == "" {
		writeCliError(w, http.StatusBadRequest, "validation", "tunnel id is required")
		return
	}
	a.cliTunnelsMu.Lock()
	record, ok := a.cliTunnels[id]
	if ok {
		delete(a.cliTunnels, id)
	}
	a.cliTunnelsMu.Unlock()
	if !ok {
		writeCliError(w, http.StatusNotFound, "daemon", "tunnel not found")
		return
	}
	a.tunnels.RemoveTunnel(record.SessionID, record.ID)
	writeCliJSON(w, http.StatusOK, map[string]any{"tunnelId": id, "closed": true})
}

func (a *App) closeCliTunnels() {
	a.cliTunnelsMu.Lock()
	records := make([]cliTunnelRecord, 0, len(a.cliTunnels))
	for _, record := range a.cliTunnels {
		records = append(records, record)
	}
	a.cliTunnels = map[string]cliTunnelRecord{}
	a.cliTunnelsMu.Unlock()
	if a.tunnels == nil {
		return
	}
	for _, record := range records {
		a.tunnels.RemoveTunnel(record.SessionID, record.ID)
	}
}

func cliTunnelPayload(record cliTunnelRecord, active bool, errorMessage string) map[string]any {
	payload := map[string]any{
		"tunnelId": record.ID, "alias": record.Alias, "type": record.Rule.Type,
		"local": record.Rule.Local, "active": active, "temporary": true,
	}
	if record.Rule.Remote != "" {
		payload["remote"] = record.Rule.Remote
	}
	if errorMessage != "" {
		payload["error"] = errorMessage
	}
	return payload
}

func normalizeCliLoopbackEndpoint(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", fmt.Errorf("local tunnel endpoint is required")
	}
	host, portText := "127.0.0.1", value
	if strings.Contains(value, ":") {
		var err error
		host, portText, err = net.SplitHostPort(value)
		if err != nil {
			return "", fmt.Errorf("invalid local endpoint %q: %w", value, err)
		}
	}
	if !strings.EqualFold(host, "localhost") {
		ip := net.ParseIP(host)
		if ip == nil || !ip.IsLoopback() {
			return "", fmt.Errorf("CLI tunnels may bind only to loopback addresses")
		}
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 0 || port > 65535 {
		return "", fmt.Errorf("local tunnel port must be between 0 and 65535")
	}
	return net.JoinHostPort(host, strconv.Itoa(port)), nil
}

func validateCliRemoteEndpoint(value string) error {
	host, portText, err := net.SplitHostPort(strings.TrimSpace(value))
	if err != nil || strings.TrimSpace(host) == "" {
		return fmt.Errorf("remote endpoint must be host:port")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return fmt.Errorf("remote tunnel port must be between 1 and 65535")
	}
	return nil
}
