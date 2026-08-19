package app

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"gxShell/backend/types"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const cliApprovalEventCommandLimit = 32 * 1024

const cliUploadPreviewLimit = 2 * 1024

type cliLocalFileInfo struct {
	Size     int64
	SHA256   string
	Preview  string
	Text     bool
	Script   bool
	FileName string
}

type cliUploadedFile struct {
	ProfileID  string
	RemotePath string
	Size       int64
	SHA256     string
	Preview    string
	Script     bool
	UploadedAt time.Time
}

// cliApprovalEvent drives the coloured in-app explanation shown while the
// native dialog is open. It is deliberately informational: only the native
// dialog result reaches the execution path.
type cliApprovalEvent struct {
	ID        string     `json:"id"`
	Alias     string     `json:"alias,omitempty"`
	Phase     string     `json:"phase"`
	Command   string     `json:"command,omitempty"`
	RiskTier  string     `json:"riskTier,omitempty"`
	RiskLabel string     `json:"riskLabel,omitempty"`
	Strength  string     `json:"strength,omitempty"`
	RiskLines []string   `json:"riskLines,omitempty"`
	Spans     []riskSpan `json:"spans,omitempty"`
}

func (a *App) emitCliApproval(event cliApprovalEvent) {
	if event.ID == "" {
		return
	}
	if a.cliApprovalEventFn != nil {
		a.cliApprovalEventFn(event)
		return
	}
	if ctx := a.ctx.Get(); ctx != nil {
		runtime.EventsEmit(ctx, "cli:approval", event)
	}
}

func (a *App) withCliApprovalEvent(alias, command string, assessment riskAssessment, strength approvalStrength, language string, riskLines []string, confirm func() bool) bool {
	id := types.NewID("approval")
	visible := truncate(command, cliApprovalEventCommandLimit)
	spans := make([]riskSpan, 0, len(assessment.Spans))
	for _, span := range assessment.Spans {
		if span.Start >= 0 && span.End <= len(visible) {
			spans = append(spans, span)
		}
	}
	a.emitCliApproval(cliApprovalEvent{
		ID: id, Alias: alias, Phase: "pending", Command: visible,
		RiskTier: assessment.Tier.String(), RiskLabel: assessment.Tier.labelForLanguage(language),
		Strength: strength.String(), RiskLines: riskLines, Spans: spans,
	})
	allowed := confirm()
	phase := "denied"
	if allowed {
		phase = "approved"
	}
	a.emitCliApproval(cliApprovalEvent{ID: id, Phase: phase})
	return allowed
}

func (s approvalStrength) String() string {
	switch s {
	case approvalNone:
		return "none"
	default:
		return "click"
	}
}

func riskCategoryList(assessment riskAssessment) []string {
	seen := map[riskCategory]bool{}
	result := make([]string, 0, len(assessment.Findings))
	for _, finding := range assessment.Findings {
		if seen[finding.Category] {
			continue
		}
		seen[finding.Category] = true
		result = append(result, string(finding.Category))
	}
	return result
}

func riskCategoryText(assessment riskAssessment) string {
	return strings.Join(riskCategoryList(assessment), ",")
}

func inspectCliLocalFile(localPath string) (cliLocalFileInfo, error) {
	file, err := os.Open(localPath)
	if err != nil {
		return cliLocalFileInfo{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return cliLocalFileInfo{}, err
	}
	if !info.Mode().IsRegular() {
		return cliLocalFileInfo{}, fmt.Errorf("source is not a regular file")
	}
	hash := sha256.New()
	preview := make([]byte, cliUploadPreviewLimit)
	n, readErr := io.ReadFull(file, preview)
	if readErr != nil && readErr != io.EOF && readErr != io.ErrUnexpectedEOF {
		return cliLocalFileInfo{}, readErr
	}
	preview = preview[:n]
	if _, err := hash.Write(preview); err != nil {
		return cliLocalFileInfo{}, err
	}
	if _, err := io.Copy(hash, file); err != nil {
		return cliLocalFileInfo{}, err
	}
	text := !strings.ContainsRune(string(preview), '\x00') && utf8.Valid(preview)
	previewText := ""
	if text {
		previewText = sanitizeCliFilePreview(string(preview))
	}
	ext := strings.ToLower(filepath.Ext(localPath))
	script := strings.HasPrefix(strings.TrimSpace(previewText), "#!")
	switch ext {
	case ".sh", ".bash", ".zsh", ".ksh", ".py", ".pl", ".rb", ".js", ".mjs", ".cjs", ".php", ".lua":
		script = true
	}
	return cliLocalFileInfo{
		Size: info.Size(), SHA256: hex.EncodeToString(hash.Sum(nil)), Preview: previewText,
		Text: text, Script: script, FileName: info.Name(),
	}, nil
}

func sanitizeCliFilePreview(value string) string {
	value = strings.ReplaceAll(value, "\r\n", "\n")
	value = strings.ReplaceAll(value, "\r", "\n")
	var cleaned strings.Builder
	for _, r := range value {
		if r == '\n' || r == '\t' || r >= 0x20 {
			cleaned.WriteRune(r)
		}
	}
	return strings.TrimSpace(cleaned.String())
}

func formatCliLocalFileApproval(info cliLocalFileInfo) string {
	if info.SHA256 == "" {
		return ""
	}
	result := fmt.Sprintf("\n\nLocal file: %d bytes\nSHA-256: %s", info.Size, info.SHA256)
	if info.Script {
		result += "\nRisk: executable script or interpreted source; file contents determine its behaviour"
	}
	if info.Preview != "" {
		result += "\n\nText preview (first 2 KiB):\n" + truncate(info.Preview, cliUploadPreviewLimit)
	} else {
		result += "\nPreview: binary or non-UTF-8 content"
	}
	return result
}

func (a *App) rememberCliUploadedFile(profileID, remotePath string, info cliLocalFileInfo) {
	key := cliUploadKey(profileID, remotePath)
	if key == "" {
		return
	}
	a.cliUploadsMu.Lock()
	defer a.cliUploadsMu.Unlock()
	if a.cliUploads == nil {
		a.cliUploads = map[string]cliUploadedFile{}
	}
	// Bound this in-memory provenance cache. It is context for later approval,
	// not durable evidence that the remote file still has the same bytes.
	if len(a.cliUploads) >= 256 {
		var oldestKey string
		var oldest time.Time
		for candidate, item := range a.cliUploads {
			if oldestKey == "" || item.UploadedAt.Before(oldest) {
				oldestKey, oldest = candidate, item.UploadedAt
			}
		}
		delete(a.cliUploads, oldestKey)
	}
	a.cliUploads[key] = cliUploadedFile{
		ProfileID: profileID, RemotePath: path.Clean(remotePath), Size: info.Size,
		SHA256: info.SHA256, Preview: info.Preview, Script: info.Script, UploadedAt: time.Now(),
	}
}

func cliUploadKey(profileID, remotePath string) string {
	profileID = strings.TrimSpace(profileID)
	remotePath = strings.TrimSpace(remotePath)
	if profileID == "" || remotePath == "" {
		return ""
	}
	return profileID + "\x00" + path.Clean(remotePath)
}

func (a *App) applyCliUploadedFileRisk(profileID, command string, assessment *riskAssessment) []cliUploadedFile {
	if assessment == nil {
		return nil
	}
	a.cliUploadsMu.Lock()
	defer a.cliUploadsMu.Unlock()
	if len(a.cliUploads) == 0 {
		return nil
	}
	matched := make([]cliUploadedFile, 0, 1)
	seen := map[string]bool{}
	for _, operand := range commandPathOperands(command) {
		key := cliUploadKey(profileID, operand)
		item, ok := a.cliUploads[key]
		if !ok || seen[key] {
			continue
		}
		seen[key] = true
		matched = append(matched, item)
		assessment.add(riskFinding{
			Tier: tierBounded, Category: riskUndecidable,
			Reason: "executes a path previously uploaded through this CLI session",
			Target: item.RemotePath, Start: -1, End: -1,
		})
	}
	assessment.Spans = collectRiskSpans(command, assessment.Findings)
	return matched
}

func formatCliUploadedFileContext(files []cliUploadedFile) string {
	if len(files) == 0 {
		return ""
	}
	var result strings.Builder
	result.WriteString("\n\nPreviously uploaded by this gxShell process (remote contents may have changed):")
	for _, file := range files {
		result.WriteString(fmt.Sprintf("\n%s · %d bytes · SHA-256 %s", file.RemotePath, file.Size, file.SHA256))
		if file.Preview != "" {
			result.WriteString("\nLast-upload preview:\n")
			result.WriteString(truncate(file.Preview, cliUploadPreviewLimit))
		}
	}
	return result.String()
}
