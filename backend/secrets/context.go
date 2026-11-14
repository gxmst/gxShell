package secrets

// Context protection runs before a result or request crosses an AI boundary.
// Matching is deliberately independent of logging: log redaction discards values,
// whereas this boundary must first save a usable credential reference.
import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

var contextPrivateKey = regexp.MustCompile(`(?s)-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----.*?(?:-----END (?:[A-Z]+ )*PRIVATE KEY-----|$)`)
var contextField = regexp.MustCompile(`(?i)["']?([a-z_][a-z0-9_.-]*|api\s+key)["']?\s*[:=]\s*("(?:\\.|[^"\\])*(?:"|$)|'[^']*(?:'|$)|[^\s\x00,"';}\]]+)`)
var contextPHP = regexp.MustCompile(`(?i)define\s*\(\s*['"]([a-z_][a-z0-9_]*)['"]\s*,\s*(['"])([^'"\r\n]+)['"]`)
var contextURL = regexp.MustCompile(`(?i)[a-z][a-z0-9+.-]*://[^\s/:@]+:([^\s/@]+)@`)
var contextToken = regexp.MustCompile(`\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b`)
var contextAuth = regexp.MustCompile(`(?i)\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:Bearer|Basic)\s+([A-Za-z0-9._~+/-]+=*)`)

// ProtectContext returns references only after capture succeeds. A failed or
// bounded-out capture masks the value instead; storage errors never expose it.
// known maps plaintext values to references and collects newly masked/captured
// values for the rest of a result batch. The caller owns it exclusively.
func ProtectContext(text string, known map[string]string, capture func(label, value string) (string, error)) string {
	values := make(map[string]string, len(known))
	for value, ref := range known {
		if value != "" {
			values[value] = ref
		}
	}
	count := 0
	save := func(label, value string) string {
		if !contextSecretValue(value) {
			return value
		}
		if ref, ok := values[value]; ok {
			return ref
		}
		ref := "<redacted>"
		if count < 100 && len(value) <= 65536 && capture != nil {
			count++
			if saved, err := capture(label, value); err == nil && strings.HasPrefix(saved, "secret://") {
				ref = saved
			}
		}
		values[value] = ref
		if known != nil {
			known[value] = ref
		}
		return ref
	}
	text = protectKubernetesContext(text, save)
	if structured, ok := protectJSONContext(text, values, save); ok {
		if known != nil {
			for value, ref := range values {
				known[value] = ref
			}
		}
		return structured
	}
	text = replaceContextKnown(text, values)
	text = contextPrivateKey.ReplaceAllStringFunc(text, func(value string) string {
		if !strings.Contains(value, "-----END ") {
			values[value] = "<redacted>"
			if known != nil {
				known[value] = "<redacted>"
			}
			return "<redacted>"
		}
		return save("private-key", value)
	})
	text = replaceContextMatches(text, contextAuth, func(s string, m []int) (int, int, string) { return m[2], m[3], save("api-key", s[m[2]:m[3]]) })
	text = replaceContextMatches(text, contextField, func(s string, m []int) (int, int, string) {
		label := s[m[2]:m[3]]
		if !contextSecretField(label) {
			return 0, 0, ""
		}
		start, end := m[4], m[5]
		raw := s[start:end]
		value := raw
		if len(raw) >= 1 && (raw[0] == '"' || raw[0] == '\'') {
			if len(raw) < 2 || raw[len(raw)-1] != raw[0] {
				if partial := raw[1:]; partial != "" {
					values[partial] = "<redacted>"
					if known != nil {
						known[partial] = "<redacted>"
					}
				}
				return start + 1, end, "<redacted>"
			}
			start++
			end--
			value = s[start:end]
			if raw[0] == '"' {
				if decoded, err := strconv.Unquote(raw); err == nil {
					value = decoded
				}
			}
		}
		prefix := ""
		if strings.EqualFold(label, "authorization") {
			if strings.EqualFold(value, "Bearer") || strings.EqualFold(value, "Basic") {
				return 0, 0, ""
			}
			if at := strings.IndexByte(value, ' '); at > 0 {
				prefix, value = value[:at+1], value[at+1:]
			}
		}
		ref := save(label, value)
		if ref == value {
			return 0, 0, ""
		}
		return start, end, prefix + ref
	})
	text = replaceContextMatches(text, contextPHP, func(s string, m []int) (int, int, string) {
		if !contextSecretField(s[m[2]:m[3]]) {
			return 0, 0, ""
		}
		return m[6], m[7], save(s[m[2]:m[3]], s[m[6]:m[7]])
	})
	text = replaceContextMatches(text, contextURL, func(s string, m []int) (int, int, string) {
		value := s[m[2]:m[3]]
		decoded, err := url.PathUnescape(value)
		if err == nil {
			value = decoded
		}
		return m[2], m[3], save("password", value)
	})
	text = contextToken.ReplaceAllStringFunc(text, func(value string) string { return save("api-key", value) })
	// Also replace unlabeled duplicates discovered elsewhere in the same result.
	return replaceContextKnown(text, values)
}

func contextSecretField(label string) bool {
	if label == "PWD" || label == "OLDPWD" {
		return false
	}
	key := strings.ToLower(strings.NewReplacer("_", "", "-", "", ".", "", " ", "").Replace(label))
	if key == "key" || key == "pwd" {
		return true
	}
	for _, suffix := range []string{"password", "passwd", "pwd", "passphrase", "apikey", "apitoken", "accesskey", "accesstoken", "refreshtoken", "authtoken", "privatekey", "secretkey", "clientsecret", "authorization", "secret", "token"} {
		if strings.HasSuffix(key, suffix) {
			return true
		}
	}
	if key == "auth" || key == "pass" {
		return true
	}
	return false
}

func contextSecretValue(value string) bool {
	if value == "" || value == "|" || value == ">" || value == "{" || value == "[" || strings.HasPrefix(value, "//") || strings.HasPrefix(value, "secret://") || strings.Contains(value, "<redacted>") || strings.Contains(value, "****") || strings.HasPrefix(value, "${") {
		return false
	}
	switch strings.ToLower(value) {
	case "null", "none", "true", "false", "undefined":
		return false
	}
	return true
}

func replaceContextMatches(text string, re *regexp.Regexp, replacement func(string, []int) (int, int, string)) string {
	var out strings.Builder
	last := 0
	for _, match := range re.FindAllStringSubmatchIndex(text, -1) {
		start, end, ref := replacement(text, match)
		if end <= start || start < last {
			continue
		}
		out.WriteString(text[last:start])
		out.WriteString(ref)
		last = end
	}
	out.WriteString(text[last:])
	return out.String()
}

func replaceContextKnown(text string, values map[string]string) string {
	type entry struct{ value, ref string }
	entries := make([]entry, 0, len(values)*3)
	for value, ref := range values {
		entries = append(entries, entry{value, ref})
		encoded, _ := json.Marshal(value)
		if escaped := string(encoded[1 : len(encoded)-1]); escaped != value {
			entries = append(entries, entry{escaped, ref})
		}
		if escaped := url.QueryEscape(value); escaped != value {
			entries = append(entries, entry{escaped, ref})
		}
		if len(value) >= 8 {
			entries = append(entries, entry{base64.StdEncoding.EncodeToString([]byte(value)), ref})
		}
	}
	sort.Slice(entries, func(i, j int) bool { return len(entries[i].value) > len(entries[j].value) })
	// One pass: a short password must not corrupt a reference just inserted by
	// another replacement. Already-protected references are kept intact too.
	args := make([]string, 0, len(entries)*2)
	for _, e := range entries {
		args = append(args, e.value, e.ref)
	}
	if len(args) == 0 {
		return text
	}
	replacer := strings.NewReplacer(args...)
	var out strings.Builder
	for len(text) > 0 {
		at := strings.Index(text, "secret://")
		if at < 0 {
			out.WriteString(replacer.Replace(text))
			break
		}
		out.WriteString(replacer.Replace(text[:at]))
		end := at + len("secret://")
		for end < len(text) && strings.ContainsRune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-", rune(text[end])) {
			end++
		}
		out.WriteString(text[at:end])
		text = text[end:]
	}
	return out.String()
}

// ReplaceContextValues masks known values and common wire encodings without
// capturing unrelated fields. Transport API keys use this before context capture.
func ReplaceContextValues(text string, values map[string]string) string {
	return replaceContextKnown(text, values)
}

// Decode structured values before scanning them. Otherwise a non-sensitive
// outer field such as message/command could hide a quoted PASSWORD assignment,
// and escaped multiline keys would be saved with literal backslashes.
func protectJSONContext(text string, values map[string]string, save func(string, string) string) (string, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || (trimmed[0] != '{' && trimmed[0] != '[') || !json.Valid([]byte(trimmed)) {
		return "", false
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.UseNumber()
	var object any
	if decoder.Decode(&object) != nil {
		return "", false
	}
	var walk func(any, string, int) any
	walk = func(value any, label string, depth int) any {
		if depth > 256 {
			return "<redacted>"
		}
		switch value := value.(type) {
		case map[string]any:
			// kubectl returns SecretList/List envelopes as well as individual
			// Secrets. Inspect every object before scanning its ordinary fields.
			if value["kind"] == "Secret" {
				for _, section := range []string{"data", "stringData"} {
					if data, ok := value[section].(map[string]any); ok {
						for key, child := range data {
							if raw, ok := child.(string); ok {
								if section == "data" {
									data[key] = protectKubernetesValue(key, raw, save)
								} else {
									data[key] = save(key, raw)
								}
							} else {
								data[key] = "<redacted>"
							}
						}
					}
				}
			}
			result := make(map[string]any, len(value))
			for key, child := range value {
				protected := walk(child, key, depth+1)
				if ref, ok := values[key]; ok {
					key = ref
				}
				result[key] = protected
			}
			return result
		case []any:
			for i := range value {
				value[i] = walk(value[i], label, depth+1)
			}
			return value
		case string:
			if contextSecretField(label) {
				prefix := ""
				if strings.EqualFold(label, "authorization") || strings.EqualFold(label, "proxy-authorization") {
					if at := strings.IndexByte(value, ' '); at > 0 {
						prefix, value = value[:at+1], value[at+1:]
					}
				}
				return prefix + save(label, value)
			}
			return ProtectContext(value, values, func(label, raw string) (string, error) { return save(label, raw), nil })
		case json.Number:
			if contextSecretField(label) {
				return save(label, value.String())
			}
		}
		return value
	}
	// A later leaf can reveal a credential appearing in an earlier log string.
	object = walk(object, "", 0)
	object = walk(object, "", 0)
	encoded, err := json.Marshal(object)
	return string(encoded), err == nil
}

// Kubernetes Secret data is base64 transport, not a credential's actual value.
// Store the decoded text so the returned reference can be used directly.
func protectKubernetesValue(label, encoded string, save func(string, string) string) string {
	if strings.HasPrefix(encoded, "secret://") || encoded == "<redacted>" {
		return encoded
	}
	value, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || !utf8.Valid(value) || strings.ContainsRune(string(value), '\x00') {
		return "<redacted>"
	}
	return save(label, string(value))
}
