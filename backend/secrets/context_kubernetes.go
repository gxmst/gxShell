package secrets

import (
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

const contextYAMLQuotedScalar = `"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'`
const contextYAMLAnchorName = `[^\s,\[\]{}]+`
const contextYAMLKindScalar = `(?:&` + contextYAMLAnchorName + `[ \t]+)?(?:` + contextYAMLQuotedScalar + `|\*` + contextYAMLAnchorName + `|(?:kind|Secret)\b)`

var contextKubernetesKind = regexp.MustCompile(`(?m)(?:^|[\s{,])(` + contextYAMLKindScalar + `)\s*:\s*(` + contextYAMLKindScalar + `)`)
var contextYAMLScalarAnchor = regexp.MustCompile(`(?:^|[\s{,]|\[)(&` + contextYAMLAnchorName + `[ \t]+(?:` + contextYAMLQuotedScalar + `|[^\r\n,\[\]{}#]+))`)
var contextYAMLDocumentBoundary = regexp.MustCompile(`(?m)^(?:---|\.\.\.)(?:[ \t]+#.*)?[ \t]*\r?$`)

const invalidKubernetesContext = "[gxShell: output withheld because Kubernetes Secret YAML could not be checked]"

func protectKubernetesContext(text string, save func(string, string) string) string {
	// JSON uses its existing precision-preserving decoder. Ordinary text is
	// never reformatted merely because it happens to be valid YAML.
	if json.Valid([]byte(text)) {
		return text
	}
	decoder := yaml.NewDecoder(strings.NewReader(text))
	var documents []*yaml.Node
	for {
		var document yaml.Node
		err := decoder.Decode(&document)
		if err == io.EOF {
			break
		}
		if err != nil {
			if hasKubernetesSecretYAML(documents) || hasKubernetesSecretKind(text) {
				return invalidKubernetesContext
			}
			return text
		}
		documents = append(documents, &document)
	}
	// Parse every document before capturing anything: a malformed tail must
	// not leave a partially understood credential available as a usable ref.
	mappings, err := indexYAMLMappings(documents)
	if err != nil {
		if hasKubernetesSecretYAML(documents) || hasKubernetesSecretKind(text) {
			return invalidKubernetesContext
		}
		return text
	}
	// Freeze recognition before masking anchors: a value shared with a kind
	// key must not make a later Secret disappear halfway through protection.
	secretMappings := map[*yaml.Node]bool{}
	for node, fields := range mappings {
		kind := resolveYAMLAlias(fields["kind"])
		if kind != nil && kind.Kind == yaml.ScalarNode && kind.Value == "Secret" {
			secretMappings[node] = true
		}
	}
	if len(secretMappings) == 0 {
		return text
	}
	changed := false
	for _, document := range documents {
		changed = protectKubernetesYAMLNode(document, mappings, secretMappings, save, 0) || changed
	}
	if !changed {
		return text
	}
	var output strings.Builder
	encoder := yaml.NewEncoder(&output)
	encoder.SetIndent(2)
	for _, document := range documents {
		if err := encoder.Encode(document); err != nil {
			return invalidKubernetesContext
		}
	}
	if err := encoder.Close(); err != nil {
		return invalidKubernetesContext
	}
	return output.String()
}

func protectKubernetesYAMLNode(node *yaml.Node, mappings map[*yaml.Node]map[string]*yaml.Node, secretMappings map[*yaml.Node]bool, save func(string, string) string, depth int) bool {
	if depth > 256 {
		redactKubernetesYAMLNode(node)
		return true
	}
	changed := false
	if node.Kind == yaml.MappingNode {
		if secretMappings[node] {
			for _, section := range []string{"data", "stringData"} {
				entry := mappings[node][section]
				if entry == nil {
					continue
				}
				data := resolveYAMLAlias(entry)
				if data == nil || data.Kind != yaml.MappingNode {
					redactKubernetesYAMLNode(entry)
					changed = true
					continue
				}
				labels := make([]string, 0, len(mappings[data]))
				for label := range mappings[data] {
					labels = append(labels, label)
				}
				sort.Strings(labels)
				for _, label := range labels {
					entry := mappings[data][label]
					value := resolveYAMLAlias(entry)
					ref := "<redacted>"
					if value != nil && value.Kind == yaml.ScalarNode && value.Tag == "!!str" {
						if section == "data" {
							ref = protectKubernetesValue(label, value.Value, save)
						} else {
							ref = save(label, value.Value)
						}
						if ref == value.Value {
							continue
						}
					} else {
						// Invalid containers can reference credentials anchored outside
						// the Secret. Mask the reachable graph before discarding it.
						redactKubernetesYAMLNode(entry)
						changed = true
						continue
					}
					// Protect the anchor as well as its alias: an encoded value
					// outside data must not survive in the serialized document.
					target := value
					if target == nil {
						target = entry
					}
					*target = yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: ref, Anchor: target.Anchor}
					changed = true
				}
			}
		}
	}
	// Alias targets already occur in the document tree at their anchor. Walk
	// Content only, avoiding repeated expansion or cycles through Alias links.
	for _, child := range node.Content {
		changed = protectKubernetesYAMLNode(child, mappings, secretMappings, save, depth+1) || changed
	}
	return changed
}

// A malformed tail must also withhold an earlier, structurally recognized
// Secret, including a kind/key written with YAML escapes or aliases.
func hasKubernetesSecretYAML(nodes []*yaml.Node) bool {
	nodes = append([]*yaml.Node(nil), nodes...)
	for len(nodes) > 0 {
		node := nodes[len(nodes)-1]
		nodes = nodes[:len(nodes)-1]
		if node.Kind == yaml.MappingNode {
			kind := resolveYAMLAlias(yamlMappingValue(node, "kind"))
			if kind != nil && kind.Kind == yaml.ScalarNode && kind.Value == "Secret" {
				return true
			}
		}
		nodes = append(nodes, node.Content...)
	}
	return false
}

func hasKubernetesSecretKind(text string) bool {
	// A broken document may yield no AST at all. Decode only scalar fragments
	// for this conservative fallback, including anchors preceding alias keys or
	// values. Anchor scope ends at each document boundary; never capture secrets
	// from these fragments or attempt to repair/serialize the malformed document.
	for _, document := range contextYAMLDocumentBoundary.Split(text, -1) {
		anchors := map[string]string{}
		definitions := contextYAMLScalarAnchor.FindAllStringSubmatchIndex(document, -1)
		nextDefinition := 0
		for _, match := range contextKubernetesKind.FindAllStringSubmatchIndex(document, -1) {
			for nextDefinition < len(definitions) && definitions[nextDefinition][0] < match[0] {
				definition := definitions[nextDefinition]
				var node yaml.Node
				if yaml.Unmarshal([]byte(document[definition[2]:definition[3]]), &node) == nil && len(node.Content) == 1 {
					scalar := node.Content[0]
					// Record non-kind definitions too so reused anchor names cannot
					// retain an earlier scalar value after being redefined.
					anchors[scalar.Anchor] = scalar.Value
				}
				nextDefinition++
			}
			key := contextYAMLScalarValue(document[match[2]:match[3]], anchors)
			kind := contextYAMLScalarValue(document[match[4]:match[5]], anchors)
			if key == "kind" && kind == "Secret" {
				return true
			}
		}
	}
	return false
}

func contextYAMLScalarValue(fragment string, anchors map[string]string) string {
	if strings.HasPrefix(fragment, "*") {
		return anchors[strings.TrimPrefix(fragment, "*")]
	}
	var node yaml.Node
	if yaml.Unmarshal([]byte(fragment), &node) != nil || len(node.Content) != 1 || node.Content[0].Kind != yaml.ScalarNode {
		return ""
	}
	return node.Content[0].Value
}

// Walk alias links as well as children, with cycle detection. Preserving anchor
// names keeps aliases elsewhere in the document valid after serialization.
func redactKubernetesYAMLNode(node *yaml.Node) {
	pending := []*yaml.Node{node}
	seen := map[*yaml.Node]bool{}
	for len(pending) > 0 {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if current == nil || seen[current] {
			continue
		}
		seen[current] = true
		pending = append(pending, current.Content...)
		if current.Alias != nil {
			pending = append(pending, current.Alias)
		}
		*current = yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "<redacted>", Anchor: current.Anchor}
	}
}

func yamlMappingValue(node *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(node.Content); i += 2 {
		resolved := resolveYAMLAlias(node.Content[i])
		if resolved != nil && resolved.Kind == yaml.ScalarNode && resolved.Value == key {
			return node.Content[i+1]
		}
	}
	return nil
}

// Preserve source nodes/anchors while resolving the same precedence as YAML
// decoding: explicit fields win, and earlier maps in a merge sequence win.
func indexYAMLMappings(documents []*yaml.Node) (map[*yaml.Node]map[string]*yaml.Node, error) {
	index := map[*yaml.Node]map[string]*yaml.Node{}
	visiting := map[*yaml.Node]bool{}
	indexedFields := 0
	var resolve func(*yaml.Node, int) (map[string]*yaml.Node, error)
	resolve = func(node *yaml.Node, depth int) (map[string]*yaml.Node, error) {
		node = resolveYAMLAlias(node)
		if node == nil || node.Kind != yaml.MappingNode || depth > 256 || visiting[node] {
			return nil, errors.New("invalid or cyclic YAML merge")
		}
		if fields, ok := index[node]; ok {
			return fields, nil
		}
		visiting[node] = true
		defer delete(visiting, node)
		fields := map[string]*yaml.Node{}
		seen := map[string]bool{}
		var merges []*yaml.Node
		for i := 0; i+1 < len(node.Content); i += 2 {
			key := resolveYAMLAlias(node.Content[i])
			if key == nil || key.Kind != yaml.ScalarNode || seen[key.Value] {
				return nil, errors.New("invalid or duplicate YAML key")
			}
			seen[key.Value] = true
			value := node.Content[i+1]
			if key.Value == "<<" && key.Tag == "!!merge" {
				value = resolveYAMLAlias(value)
				if value == nil {
					return nil, errors.New("invalid YAML merge")
				}
				if value.Kind == yaml.SequenceNode {
					merges = append(merges, value.Content...)
				} else {
					merges = append(merges, value)
				}
			} else {
				fields[key.Value] = value
			}
		}
		for _, merge := range merges {
			inherited, err := resolve(merge, depth+1)
			if err != nil {
				return nil, err
			}
			for key, value := range inherited {
				if _, explicit := fields[key]; !explicit {
					fields[key] = value
				}
			}
		}
		indexedFields += len(fields)
		if indexedFields > 100000 {
			return nil, errors.New("YAML merge expansion exceeds context limit")
		}
		index[node] = fields
		return fields, nil
	}
	pending := append([]*yaml.Node(nil), documents...)
	for len(pending) > 0 {
		node := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if node.Kind == yaml.MappingNode {
			if _, err := resolve(node, 0); err != nil {
				return nil, err
			}
		}
		pending = append(pending, node.Content...)
	}
	return index, nil
}

func resolveYAMLAlias(node *yaml.Node) *yaml.Node {
	for depth := 0; node != nil && node.Kind == yaml.AliasNode; depth++ {
		if depth >= 256 {
			return nil
		}
		node = node.Alias
	}
	return node
}
