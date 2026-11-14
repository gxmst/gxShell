package app

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"gxShell/backend/ai"
	"gxShell/backend/secrets"
	sshmanager "gxShell/backend/ssh"
)

// protectCredentialTexts is the common local boundary for tool output, CLI/MCP
// results and provider requests. Recognized values are replaced before delivery.
// Serialising a pass also avoids duplicate captures from parallel tool results.
func (a *App) protectCredentialTexts(texts ...string) []string {
	return a.protectCredentialTextsWithKnown(nil, texts...)
}

// Keep captures and masks from earlier passes alive for the whole result,
// including values that could not be persisted in the credential store.
func (a *App) protectCredentialTextsWithKnown(known map[string]string, texts ...string) []string {
	a.credentialContextMu.Lock()
	defer a.credentialContextMu.Unlock()
	if known == nil {
		known = map[string]string{}
	}
	failed := false
	if a.secrets != nil {
		names, err := a.secrets.NamedNames(cliSecretNamespace)
		failed = err != nil
		for _, name := range names {
			if !cliSecretAliasPattern.MatchString(name) {
				continue
			}
			value, err := a.secrets.GetNamed(cliSecretNamespace, name)
			if err != nil {
				failed = true
				break
			}
			if value != "" {
				known[value] = "secret://" + name
			}
		}
	}
	capture := func(label, value string) (ref string, captureErr error) {
		defer func() {
			if captureErr != nil {
				known[value] = "<redacted>"
			}
		}()
		if len(value) > 65536 || strings.ContainsRune(value, '\x00') {
			return "", errors.New("unsupported credential value")
		}
		if ref, ok := known[value]; ok {
			return ref, nil
		}
		if a.secrets == nil {
			return "", errors.New("credential storage unavailable")
		}
		var random [16]byte
		if _, err := rand.Read(random[:]); err != nil {
			return "", err
		}
		label = strings.ToLower(label)
		var clean strings.Builder
		for _, ch := range label {
			if ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' {
				clean.WriteRune(ch)
			}
		}
		label = clean.String()
		if len(label) > 20 {
			label = label[:20]
		}
		if label == "" {
			label = "credential"
		}
		name := "auto-" + label + "-" + hex.EncodeToString(random[:])
		empty := ""
		if err := a.secrets.ApplyMigration([]secrets.Value{{ID: "named:" + cliSecretNamespace + ":" + name, Kind: "value", Text: value, Expected: &empty}}, func() error { return nil }); err != nil {
			return "", errors.New("failed to capture credential")
		}
		ref = "secret://" + name
		known[value] = ref
		return ref, nil
	}
	// SSH passwords (including jump hosts and other saved users) are matched by
	// value too, even when an API response or terminal line has no field label.
	matchSaved := func(label, value string) {
		if value == "" {
			return
		}
		for _, text := range texts {
			if secrets.ReplaceContextValues(text, map[string]string{value: "<redacted>"}) != text {
				ref, err := capture(label, value)
				if err != nil {
					ref = "<redacted>"
				}
				known[value] = ref
				return
			}
		}
	}
	if a.secrets != nil && a.store != nil {
		profiles, err := a.store.ListProfiles()
		if err != nil {
			failed = true
		}
		for _, profile := range profiles {
			if value, err := a.secrets.GetPassword(profile.ID); err != nil {
				failed = true
			} else {
				matchSaved("ssh-password", value)
			}
			if value, err := a.secrets.GetPassphrase(profile.ID); err != nil {
				failed = true
			} else {
				matchSaved("key-passphrase", value)
			}
		}
	}
	if a.ai != nil {
		matchSaved("ai-api-key", a.ai.GetConfig().APIKey)
	}
	out := make([]string, len(texts))
	if failed {
		for i := range out {
			out[i] = "[gxShell: output withheld because saved credentials could not be checked]"
		}
		return out
	}
	// Process the complete batch twice: credentials found in stderr must also
	// redact unlabeled occurrences in stdout and older history messages.
	for i, text := range texts {
		out[i] = secrets.ProtectContext(text, known, capture)
	}
	for i := range out {
		out[i] = secrets.ProtectContext(out[i], known, capture)
	}
	return out
}

func (a *App) protectCredentialResult(result *sshmanager.CommandExecutionResult, command ...string) {
	known := map[string]string{}
	// A known credential file may contain an unlabeled password or an opaque
	// credential format. Partial field matching cannot prove the remaining bytes
	// are harmless, so always return a reference to the complete cat result.
	if len(command) > 0 && result.Stdout != "" && isCredentialFileRead(command[0]) {
		original := result.Stdout
		// Keep individually recognized values usable in the credential inventory.
		a.protectCredentialTextsWithKnown(known, original)
		result.Stdout = "<redacted>"
		if !result.Truncated {
			valueToStore := original
			if line := strings.TrimRight(original, "\r\n"); !strings.ContainsAny(line, "\r\n") {
				valueToStore = line
			}
			encoded, _ := json.Marshal(map[string]string{"file_secret": valueToStore})
			captured := a.protectCredentialTextsWithKnown(known, string(encoded))[0]
			var value map[string]string
			if json.Unmarshal([]byte(captured), &value) == nil && strings.HasPrefix(value["file_secret"], "secret://") {
				result.Stdout = value["file_secret"]
			}
		}
		known[original] = result.Stdout
		if trimmed := strings.TrimRight(original, "\r\n"); trimmed != "" {
			known[trimmed] = result.Stdout
		}
		// Replace before parsing: reformatting a YAML result could otherwise
		// change the complete file bytes used as the replacement key.
		result.Stderr = secrets.ReplaceContextValues(result.Stderr, known)
		result.Output = secrets.ReplaceContextValues(result.Output, known)
		result.Summary = secrets.ReplaceContextValues(result.Summary, known)
		result.Error = secrets.ReplaceContextValues(result.Error, known)
	}
	texts := a.protectCredentialTextsWithKnown(known, result.Stdout, result.Stderr, result.Output, result.Summary, result.Error)
	result.Stdout, result.Stderr, result.Output, result.Summary, result.Error = texts[0], texts[1], texts[2], texts[3], texts[4]
}

func isCredentialFileRead(command string) bool {
	tokens := tokenizeCommand(command)
	index, _, _ := skipPrivilegeWrappers(tokens)
	if index >= len(tokens) || shellCommandName(tokens[index].Text) != "cat" {
		return false
	}
	for _, token := range tokens[index+1:] {
		if class, ok := credentialPathClass(strings.ToLower(token.Text)); ok && class == pathCredentialStore {
			return true
		}
	}
	return false
}

func (a *App) protectAIRequest(cfg ai.Config, req ai.ChatRequest) ai.ChatRequest {
	req.Messages = append([]ai.Message(nil), req.Messages...)
	req.ToolResults = append([]ai.ToolResult(nil), req.ToolResults...)
	texts := []string{req.Context, req.Instructions}
	for i := range req.Messages {
		req.Messages[i].ToolCalls = append([]ai.ToolCall(nil), req.Messages[i].ToolCalls...)
		message := req.Messages[i]
		texts = append(texts, message.Content, message.ReasoningContent)
		for _, call := range message.ToolCalls {
			texts = append(texts, call.Function.Arguments)
		}
	}
	for _, result := range req.ToolResults {
		texts = append(texts, result.Content)
	}
	// Config is transport-only: never turn authentication headers into refs.
	// A pinned task may use a different gateway key than the current config.
	if cfg.APIKey != "" {
		keyRef := "<redacted>"
		for _, text := range texts {
			if secrets.ReplaceContextValues(text, map[string]string{cfg.APIKey: "<redacted>"}) == text {
				continue
			}
			encoded, _ := json.Marshal(map[string]string{"api_key": cfg.APIKey})
			protected := a.protectCredentialTexts(string(encoded))[0]
			var captured map[string]string
			if json.Unmarshal([]byte(protected), &captured) == nil && strings.HasPrefix(captured["api_key"], "secret://") {
				keyRef = captured["api_key"]
			}
			break
		}
		for i := range texts {
			texts[i] = secrets.ReplaceContextValues(texts[i], map[string]string{cfg.APIKey: keyRef})
		}
	}
	texts = a.protectCredentialTexts(texts...)
	req.Context, req.Instructions = texts[0], texts[1]
	at := 2
	for i := range req.Messages {
		req.Messages[i].Content, req.Messages[i].ReasoningContent = texts[at], texts[at+1]
		at += 2
		for j := range req.Messages[i].ToolCalls {
			req.Messages[i].ToolCalls[j].Function.Arguments = texts[at]
			at++
		}
	}
	for i := range req.ToolResults {
		req.ToolResults[i].Content = texts[at]
		at++
	}
	return req
}
