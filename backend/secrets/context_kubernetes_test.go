package secrets

import (
	"fmt"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestKubernetesYAMLEscapedKindAndKeyAreProtected(t *testing.T) {
	for _, prefix := range []string{
		`kind: "Sec\x72et"`,
		`kind: "Sec\u0072et"`,
		`"ki\x6ed": "Sec\U00000072et"`,
		"label: &kind Secret\nkind: *kind",
	} {
		t.Run(prefix, func(t *testing.T) {
			input := prefix + "\ndata:\n  opaque: cGFzcw==\n"
			var parsed map[string]any
			if err := yaml.Unmarshal([]byte(input), &parsed); err != nil || parsed["kind"] != "Secret" {
				t.Fatalf("invalid fixture: %v %v", parsed, err)
			}
			calls := 0
			output := ProtectContext(input, nil, func(label, value string) (string, error) {
				calls++
				if label != "opaque" || value != "pass" {
					t.Fatalf("incorrect capture: %q %q", label, value)
				}
				return "secret://escaped-kind", nil
			})
			if calls != 1 || strings.Contains(output, "cGFzcw==") || !strings.Contains(output, "secret://escaped-kind") {
				t.Fatalf("escaped Secret leaked: %s", output)
			}
		})
	}
}

func TestMalformedEscapedSecretYAMLIsWithheld(t *testing.T) {
	for _, input := range []string{
		"kind: \"Sec\\x72et\"\ndata:\n  opaque: cGFzcw==\nitems: [",
		"label: &kind Secret\nkind: *kind\ndata:\n  opaque: cGFzcw==\n---\nitems: [",
	} {
		output := ProtectContext(input, nil, func(string, string) (string, error) {
			t.Fatal("malformed output must not capture a usable credential")
			return "", nil
		})
		if output != invalidKubernetesContext {
			t.Fatalf("malformed Secret escaped: %s", output)
		}
	}
}

func TestMalformedSecretYAMLAliasKindIsWithheld(t *testing.T) {
	for name, prefix := range map[string]string{
		"alias-key":                   "metadata:\n  annotations:\n    key: &k kind\n*k: Secret",
		"alias-key-and-value":         "keyName: &k kind\nkindName: &v Secret\n*k: *v",
		"quoted-alias-key":            "keyName: &k 'kind'\n*k: 'Secret'",
		"escaped-alias-key-and-value": "keyName: &k \"ki\\x6ed\"\nkindName: &v \"Sec\\u0072et\"\n*k: *v",
		"alias-value":                 "kindName: &v Secret\nkind: *v",
		"escaped-key-alias-value":     "kindName: &v Secret\n\"ki\\x6ed\": *v",
		"inline-anchors":              "names: {keyName: &k kind, kindName: &v Secret}\n*k: *v",
	} {
		t.Run(name, func(t *testing.T) {
			input := prefix + "\ndata:\n  opaque: cGFzcw==\nitems: ["
			output := ProtectContext(input, nil, func(string, string) (string, error) {
				t.Fatal("malformed aliased Secret must not capture a credential")
				return "", nil
			})
			if output != invalidKubernetesContext {
				t.Fatalf("malformed aliased Secret escaped: %s", output)
			}
		})
	}
}

func TestMalformedNonSecretAliasYAMLStaysUnchanged(t *testing.T) {
	for _, input := range []string{
		"keyName: &k category\n*k: Secret\ndata: {opaque: cGFzcw==}\nitems: [",
		"keyName: &k kind\nkindName: &v ConfigMap\n*k: *v\nitems: [",
		"first: &k kind\nsecond: &k category\n*k: Secret\nitems: [",
		"keyName: &k kind\n---\n*k: Secret\nitems: [",
		"diff --git a/secret.yaml b/secret.yaml\n+keyName: &k kind\n+*k: Secret\n+items: [",
	} {
		if output := ProtectContext(input, nil, nil); output != input {
			t.Fatalf("unrelated alias output changed: %s", output)
		}
	}
}

func TestUnsupportedSecretContainersMaskExternalAliasTargets(t *testing.T) {
	for _, section := range []string{"data", "stringData"} {
		for _, container := range []string{"[*shared]", "{ nested: [*shared] }", "&loop [*loop, *shared]"} {
			for _, field := range []string{"", "wrapped: "} {
				input := "shared: &shared cGFzcw==\nkind: Secret\n" + section + ":\n  " + field + container + "\n"
				var fixture yaml.Node
				if err := yaml.Unmarshal([]byte(input), &fixture); err != nil {
					t.Fatalf("invalid fixture: %v", err)
				}
				output := ProtectContext(input, nil, func(string, string) (string, error) {
					t.Fatal("invalid containers must be masked, not captured")
					return "", nil
				})
				if strings.Contains(output, "cGFzcw==") || strings.Contains(output, "secret://") {
					t.Fatalf("external anchor leaked: %s", output)
				}
				var parsed yaml.Node
				if err := yaml.Unmarshal([]byte(output), &parsed); err != nil {
					t.Fatalf("mask broke YAML aliases: %v\n%s", err, output)
				}
			}
		}
	}
}

func TestNonSecretYAMLAndOrdinaryTextStayUnchanged(t *testing.T) {
	for _, input := range []string{
		"kind: \"ConfigMap\"\ndata:\n  opaque: cGFzcw==\n",
		"kubectl failed: no connection\nretry later\n",
		"diff --git a/secret.yaml b/secret.yaml\n@@ -1 +1 @@\n+kind: Secret\n+data:\n+  opaque: cGFzcw==\n",
	} {
		if output := ProtectContext(input, nil, nil); output != input {
			t.Fatalf("unrelated output changed: %s", output)
		}
	}
}

func TestSecretYAMLAliasKeysAndMergeOverridesAreProtected(t *testing.T) {
	for name, input := range map[string]string{
		"alias-kind":        "apiVersion: v1\nmetadata:\n  name: alias-kind\n  annotations:\n    key: &k kind\n*k: Secret\ndata:\n  opaque: cGFzcw==\n",
		"alias-data":        "apiVersion: v1\nkind: Secret\nmetadata:\n  name: alias-data\n  annotations:\n    key: &d data\n*d:\n  opaque: cGFzcw==\n",
		"merge-kind":        "kind: List\nitems:\n- &tpl\n  kind: Secret\n- <<: *tpl\n  data:\n    opaque: cGFzcw==\n",
		"merge-override":    "kind: List\nitems:\n- &tpl\n  kind: Secret\n  data:\n    opaque: cHVibGlj\n- <<: *tpl\n  data:\n    opaque: cGFzcw==\n",
		"data-merge":        "fields: &fields {opaque: cGFzcw==}\nkind: Secret\ndata: {<<: *fields}\n",
		"stringData-merge":  "fields: &fields {opaque: pass}\nkind: Secret\nstringData: {<<: *fields}\n",
		"shared-kind-value": "kind: &kind Secret\ndata: {opaque: *kind}\nchild:\n  kind: *kind\n  data: {opaque: cGFzcw==}\n",
	} {
		t.Run(name, func(t *testing.T) {
			var parsed yaml.Node
			if err := yaml.Unmarshal([]byte(input), &parsed); err != nil {
				t.Fatalf("invalid fixture: %v", err)
			}
			output := ProtectContext(input, nil, func(string, string) (string, error) { return "secret://merged", nil })
			if strings.Contains(output, "cGFzcw==") || strings.Contains(output, "pass") || !strings.Contains(output, "secret://merged") {
				t.Fatalf("merged or aliased Secret escaped: %s", output)
			}
			if err := yaml.Unmarshal([]byte(output), &parsed); err != nil {
				t.Fatalf("protection broke YAML aliases: %v", err)
			}
		})
	}
}

func TestSecretYAMLMergePrecedenceMatchesDecoder(t *testing.T) {
	for _, fixture := range []struct {
		fields string
		secret bool
	}{
		{"<<: [*secret, *public]", true},
		{"<<: [*public, *secret]", false},
		{"<<: *secret\n  kind: ConfigMap", false},
	} {
		input := "first: &secret {kind: Secret}\nsecond: &public {kind: ConfigMap}\nresult:\n  " + fixture.fields + "\n  data: {opaque: cGFzcw==}\n"
		var decoded map[string]any
		if err := yaml.Unmarshal([]byte(input), &decoded); err != nil {
			t.Fatal(err)
		}
		output := ProtectContext(input, nil, func(string, string) (string, error) { return "secret://merged", nil })
		var protected map[string]any
		if err := yaml.Unmarshal([]byte(output), &protected); err != nil {
			t.Fatal(err)
		}
		result := protected["result"].(map[string]any)
		value := result["data"].(map[string]any)["opaque"]
		if fixture.secret && value != "secret://merged" || !fixture.secret && value != "cGFzcw==" {
			t.Fatalf("merge precedence changed: %v", result)
		}
	}
}

func TestInvalidSecretYAMLMergesAndDuplicateKeysAreWithheld(t *testing.T) {
	for _, input := range []string{
		"kind: Secret\n<<: invalid\ndata: {opaque: cGFzcw==}\n",
		"value: &loop {<<: *loop}\nkind: Secret\ndata: {opaque: cGFzcw==}\n",
		"kind: ConfigMap\nkind: Secret\ndata: {opaque: cGFzcw==}\n",
	} {
		if output := ProtectContext(input, nil, nil); output != invalidKubernetesContext {
			t.Fatalf("invalid Secret mapping escaped: %s", output)
		}
	}
}

func TestSecretYAMLMergeExpansionIsBoundedBeforeCapture(t *testing.T) {
	var input strings.Builder
	input.WriteString("template: &template\n  kind: Secret\n  data: {opaque: cGFzcw==}\n")
	for field := 0; field < 200; field++ {
		fmt.Fprintf(&input, "  field%d: public\n", field)
	}
	input.WriteString("items:\n")
	for item := 0; item < 600; item++ {
		input.WriteString("- <<: *template\n")
	}
	output := ProtectContext(input.String(), nil, func(string, string) (string, error) {
		t.Fatal("excessive alias expansion must be rejected before capture")
		return "", nil
	})
	if output != invalidKubernetesContext {
		t.Fatal("excessive merge expansion was not withheld")
	}
}
