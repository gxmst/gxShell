package app

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"

	"gxShell/backend/logger"
	sshmanager "gxShell/backend/ssh"
)

const cliSecretNamespace = "cli"

var (
	cliSecretAliasPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	cliSecretEnvPattern   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
)

func decodeCliJSON(r *http.Request, dst any) error {
	return json.NewDecoder(io.LimitReader(r.Body, cliMaxRequestSize)).Decode(dst)
}

func (a *App) handleCliSecrets(w http.ResponseWriter, r *http.Request) {
	alias := strings.TrimSpace(r.URL.Query().Get("alias"))
	switch r.Method {
	case http.MethodGet:
		if !cliSecretAliasPattern.MatchString(alias) {
			writeCliError(w, http.StatusBadRequest, "validation", "valid secret alias is required")
			return
		}
		value, err := a.secrets.GetNamed(cliSecretNamespace, alias)
		if err != nil {
			writeCliError(w, http.StatusInternalServerError, "secret", "failed to read named secret")
			return
		}
		writeCliJSON(w, http.StatusOK, map[string]any{"alias": alias, "exists": value != "", "reference": "secret://" + alias})

	case http.MethodPost:
		var req struct{ Alias, Value string }
		if err := decodeCliJSON(r, &req); err != nil {
			writeCliError(w, http.StatusBadRequest, "validation", err.Error())
			return
		}
		req.Alias = strings.TrimSpace(req.Alias)
		if !cliSecretAliasPattern.MatchString(req.Alias) || req.Value == "" {
			writeCliError(w, http.StatusBadRequest, "validation", "valid alias and non-empty secret value are required")
			return
		}
		if strings.ContainsAny(req.Value, "\r\n\x00") {
			writeCliError(w, http.StatusBadRequest, "validation", "secret values cannot contain newlines or NUL bytes")
			return
		}
		if !a.confirmCliExecution("local secret store", "Store or update named secret secret://"+req.Alias+" (value hidden)") {
			writeCliError(w, http.StatusForbidden, "blocked", "user declined named secret update")
			return
		}
		if err := a.secrets.SaveNamed(cliSecretNamespace, req.Alias, req.Value); err != nil {
			writeCliError(w, http.StatusInternalServerError, "secret", "failed to store named secret")
			return
		}
		writeCliJSON(w, http.StatusOK, map[string]any{"alias": req.Alias, "stored": true, "reference": "secret://" + req.Alias})

	case http.MethodDelete:
		if !cliSecretAliasPattern.MatchString(alias) {
			writeCliError(w, http.StatusBadRequest, "validation", "valid secret alias is required")
			return
		}
		if !a.confirmCliExecution("local secret store", "Delete named secret secret://"+alias) {
			writeCliError(w, http.StatusForbidden, "blocked", "user declined named secret deletion")
			return
		}
		a.secrets.DeleteNamed(cliSecretNamespace, alias)
		writeCliJSON(w, http.StatusOK, map[string]any{"alias": alias, "deleted": true})
	default:
		writeCliError(w, http.StatusMethodNotAllowed, "validation", "method not allowed")
	}
}

func (a *App) resolveCliSecretRefs(refs map[string]string) (map[string]string, []string, error) {
	values := make(map[string]string, len(refs))
	names := make([]string, 0, len(refs))
	for envName, alias := range refs {
		alias = strings.TrimPrefix(strings.TrimSpace(alias), "secret://")
		if !cliSecretEnvPattern.MatchString(envName) || !cliSecretAliasPattern.MatchString(alias) {
			return nil, nil, fmt.Errorf("invalid secret binding %q=%q", envName, alias)
		}
		value, err := a.secrets.GetNamed(cliSecretNamespace, alias)
		if err != nil {
			return nil, nil, fmt.Errorf("failed to resolve secret://%s", alias)
		}
		if value == "" {
			return nil, nil, fmt.Errorf("named secret secret://%s does not exist", alias)
		}
		values[envName] = value
		names = append(names, envName+"=secret://"+alias)
	}
	sort.Strings(names)
	return values, names, nil
}

func buildSecretExecutionScript(values map[string]string, command, script string) string {
	var b strings.Builder
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		b.WriteString("export " + key + "=" + shellescape(values[key]) + "\n")
	}
	if script != "" {
		b.WriteString(script)
	} else {
		b.WriteString(command)
	}
	if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
		b.WriteByte('\n')
	}
	return b.String()
}

func redactCommandExecutionResult(result *sshmanager.CommandExecutionResult, values map[string]string) {
	known := secretMapValues(values)
	result.Stdout = logger.RedactKnownSecrets(result.Stdout, known)
	result.Stderr = logger.RedactKnownSecrets(result.Stderr, known)
	result.Output = logger.RedactKnownSecrets(result.Output, known)
	result.Summary = logger.RedactKnownSecrets(result.Summary, known)
	result.Error = logger.RedactKnownSecrets(result.Error, known)
}

func secretMapValues(values map[string]string) []string {
	known := make([]string, 0, len(values))
	for _, value := range values {
		known = append(known, value)
	}
	return known
}
