package secrets

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"
)

func TestProtectContextCapturesCredentialsAndPreservesUsableValues(t *testing.T) {
	privateKey := "-----BEGIN OPENSSH PRIVATE KEY-----\ncanary-private-body\n-----END OPENSSH PRIVATE KEY-----"
	input := `{"base_url":"https://api.example.test","API_KEY":"key-canary-123","root_password":"root-canary","ubuntuPassword":"ubuntu-canary","password":"quote\"canary"}` +
		"\nAuthorization: Bearer header-canary\nDB_PASSWORD=mysql-canary\x00OTHER=normal\n" +
		"define('DB_PASSWORD', 'php-canary');\npostgres://db:url%40canary@localhost/db\n" + privateKey + "\nrepeat key-canary-123"
	captured := map[string]string{}
	output := ProtectContext(input, nil, func(label, value string) (string, error) {
		ref := fmt.Sprintf("secret://auto-%d", len(captured))
		captured[ref] = value
		return ref, nil
	})
	for _, value := range []string{"key-canary-123", "root-canary", "ubuntu-canary", `quote"canary`, "header-canary", "mysql-canary", "php-canary", "url@canary", privateKey} {
		found := false
		for _, saved := range captured {
			if saved == value {
				found = true
			}
		}
		if !found {
			t.Fatalf("credential was not captured: label for %q; output=%s", value, output)
		}
		if strings.Contains(output, value) {
			t.Fatalf("plaintext escaped: %q", value)
		}
	}
	if !strings.Contains(output, "https://api.example.test") || !strings.Contains(output, "Authorization: Bearer secret://") || !strings.Contains(output, "OTHER=normal") {
		t.Fatalf("non-secret context damaged: %s", output)
	}
}

func TestProtectContextReusesReferencesAndMasksEncodedKnownValues(t *testing.T) {
	value := "known-canary-password"
	ref := "secret://known-canary-password"
	input := value + " " + base64.StdEncoding.EncodeToString([]byte(value)) + " password=" + ref
	output := ProtectContext(input, map[string]string{value: ref}, func(string, string) (string, error) { t.Fatal("existing value was captured again"); return "", nil })
	if strings.Contains(output, base64.StdEncoding.EncodeToString([]byte(value))) || strings.Count(output, ref) != 3 {
		t.Fatalf("reference reuse: %s", output)
	}
	if again := ProtectContext(output, map[string]string{value: ref}, nil); again != output {
		t.Fatalf("protection is not idempotent: %s", again)
	}
}

func TestProtectContextStorageFailureAndTruncatedPEMFailClosed(t *testing.T) {
	input := "PASSWORD=failed-canary\n-----BEGIN RSA PRIVATE KEY-----\ntruncated-private-canary"
	output := ProtectContext(input, nil, func(string, string) (string, error) { return "", errors.New("storage unavailable") })
	if strings.Contains(output, "canary") || strings.Contains(output, "secret://") {
		t.Fatalf("failed capture exposed a value or unusable reference: %s", output)
	}
}

func TestProtectContextKubernetesStoresDecodedCredential(t *testing.T) {
	value := "kubernetes-canary"
	encoded := base64.StdEncoding.EncodeToString([]byte(value))
	for _, input := range []string{`{"kind":"Secret","data":{"custom-field":"` + encoded + `"}}`, "data:\n  custom-field: " + encoded + "\nkind: Secret\n"} {
		calls := 0
		output := ProtectContext(input, nil, func(label, raw string) (string, error) {
			calls++
			if raw != value {
				t.Error("stored base64 transport instead of actual credential")
			}
			return "secret://kube-key", nil
		})
		if calls != 1 || strings.Contains(output, encoded) || !strings.Contains(output, "secret://kube-key") {
			t.Fatalf("Kubernetes capture: %s", output)
		}
	}
}

func TestProtectContextKubernetesListsAndNestedSecrets(t *testing.T) {
	value := "kubernetes-list-canary"
	encoded := base64.StdEncoding.EncodeToString([]byte(value))
	secret := `{"kind":"Secret","data":{"custom-field":"` + encoded + `"},"stringData":{"custom-text":"` + value + `"}}`
	for _, input := range []string{
		`{"kind":"SecretList","items":[` + secret + `],"revision":9007199254740993}`,
		`{"kind":"List","items":[` + secret + `],"revision":9007199254740993}`,
		`{"result":` + secret + `,"revision":9007199254740993}`,
		`[` + secret + `,{"kind":"ConfigMap","data":{"ordinary":"cGxhaW4="},"revision":9007199254740993}]`,
	} {
		t.Run(input, func(t *testing.T) {
			calls := 0
			output := ProtectContext(input, nil, func(label, raw string) (string, error) {
				calls++
				if raw != value {
					t.Fatalf("stored transport encoding instead of credential: %q", raw)
				}
				return "secret://kube-list", nil
			})
			if calls != 1 || strings.Contains(output, encoded) || strings.Contains(output, value) || !json.Valid([]byte(output)) || !strings.Contains(output, "9007199254740993") {
				t.Fatalf("nested Kubernetes capture or metadata preservation failed: %s", output)
			}
			if strings.Contains(input, "ConfigMap") && !strings.Contains(output, "cGxhaW4=") {
				t.Fatal("ordinary ConfigMap data changed")
			}
			failed := ProtectContext(input, nil, func(string, string) (string, error) { return "", errors.New("storage unavailable") })
			if strings.Contains(failed, encoded) || strings.Contains(failed, value) || strings.Contains(failed, "secret://") {
				t.Fatal("failed nested capture leaked or returned an unusable reference")
			}
		})
	}
}

func TestProtectContextTruncatedQuotedPasswordIsMaskedWithoutCapture(t *testing.T) {
	output := ProtectContext(`{"password":"unfinished-canary`, nil, func(string, string) (string, error) {
		t.Fatal("incomplete value must not be saved as a usable credential")
		return "", nil
	})
	if strings.Contains(output, "canary") || !strings.Contains(output, "<redacted>") {
		t.Fatalf("truncated credential escaped: %s", output)
	}
}

func TestProtectContextScansNestedLogStringsAndPreservesEscapedKeyValues(t *testing.T) {
	privateKey := "-----BEGIN PRIVATE KEY-----\nbody-canary\n-----END PRIVATE KEY-----"
	input := `{"command":"API_KEY=embedded-canary","message":"password=\"quoted-canary\"","counter":9007199254740993,"private_key":` + strconv.Quote(privateKey) + `}`
	saved := map[string]bool{}
	output := ProtectContext(input, nil, func(label, value string) (string, error) { saved[value] = true; return "secret://nested-key", nil })
	for _, value := range []string{"embedded-canary", "quoted-canary", privateKey} {
		if !saved[value] {
			t.Errorf("nested credential was not decoded/captured: %q", value)
		}
	}
	if !json.Valid([]byte(output)) || strings.Contains(output, "canary") || !strings.Contains(output, "9007199254740993") {
		t.Fatalf("nested protection corrupted metadata or leaked: %s", output)
	}
}

func TestProtectContextOversizedValueRemainsMaskedAcrossBatch(t *testing.T) {
	value := strings.Repeat("oversized-canary", 5000)
	known := map[string]string{}
	ProtectContext("PASSWORD="+value, known, func(string, string) (string, error) {
		t.Fatal("oversized credential should not be stored")
		return "", nil
	})
	if output := ProtectContext(value, known, nil); strings.Contains(output, "canary") {
		t.Fatal("unsupported value leaked through an unlabeled duplicate")
	}
}

func TestProtectContextCommonCredentialFieldsKeepWorkingDirectory(t *testing.T) {
	input := "PWD=/srv/app\nOLDPWD=/root\nAWS_SECRET_ACCESS_KEY=aws-canary\nroot_pwd=root-canary\n" + `{"auth":"docker-canary"}`
	values := map[string]bool{}
	output := ProtectContext(input, nil, func(label, value string) (string, error) { values[value] = true; return "secret://common-key", nil })
	if !strings.Contains(output, "PWD=/srv/app") || !strings.Contains(output, "OLDPWD=/root") {
		t.Fatal("working directory was mistaken for a password")
	}
	for _, value := range []string{"aws-canary", "root-canary", "docker-canary"} {
		if !values[value] || strings.Contains(output, value) {
			t.Errorf("common credential field escaped: %q", value)
		}
	}
}
