package version

import (
	"strconv"
	"strings"
)

// Compare orders two version strings, returning -1 if a sorts before b, 1 if a
// sorts after b, and 0 if they are equivalent.
//
// This is a deliberately small subset of semver: numeric major/minor/patch plus
// an optional pre-release suffix. It exists because comparing release tags with
// strings.Compare gets "1.10.0" < "1.9.0" wrong, and pulling in a semver library
// for one comparison is not worth the dependency. A missing component counts as
// zero, so "1.4" and "1.4.0" are equal.
func Compare(a, b string) int {
	aVersion, aValid := parse(a)
	bVersion, bValid := parse(b)
	switch {
	case !aValid && !bValid:
		return 0
	case !aValid:
		return -1
	case !bValid:
		return 1
	}

	for i := 0; i < 3; i++ {
		if d := cmpInt(aVersion.core[i], bVersion.core[i]); d != 0 {
			return d
		}
	}

	// A pre-release sorts before the matching release: 1.4.0-rc.1 < 1.4.0. This
	// keeps a user running a release build from being offered an older rc as an
	// update, and matches semver's own precedence rule.
	switch {
	case aVersion.pre == "" && bVersion.pre == "":
		return 0
	case aVersion.pre == "":
		return 1
	case bVersion.pre == "":
		return -1
	}
	return cmpPre(aVersion.pre, bVersion.pre)
}

// IsNewer reports whether candidate is a strictly newer version than current.
func IsNewer(current, candidate string) bool {
	return Compare(current, candidate) < 0
}

// Normalize strips the decoration release tags carry ("v1.4.0", " 1.4.0 ") so
// the result can be compared or displayed.
func Normalize(v string) string {
	return strings.TrimPrefix(strings.TrimSpace(v), "v")
}

type parsedVersion struct {
	core [3]int
	pre  string
}

// Valid reports whether v belongs to the supported semver subset. One to three
// numeric core components are accepted, so 1.4 remains equivalent to 1.4.0;
// present-but-nonnumeric components such as 2.x.0 are rejected.
func Valid(v string) bool {
	_, ok := parse(v)
	return ok
}

func parse(v string) (parsedVersion, bool) {
	var parsed parsedVersion
	v = Normalize(v)
	if v == "" || strings.Count(v, "+") > 1 {
		return parsed, false
	}
	if i := strings.IndexByte(v, '+'); i >= 0 {
		if !validIdentifiers(v[i+1:]) {
			return parsed, false
		}
		v = v[:i]
	}
	if i := strings.IndexByte(v, '-'); i >= 0 {
		parsed.pre = v[i+1:]
		if !validIdentifiers(parsed.pre) {
			return parsedVersion{}, false
		}
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) == 0 || len(parts) > len(parsed.core) {
		return parsedVersion{}, false
	}
	for i, part := range parts {
		if part == "" || strings.IndexFunc(part, func(r rune) bool { return r < '0' || r > '9' }) >= 0 {
			return parsedVersion{}, false
		}
		n, err := strconv.Atoi(part)
		if err != nil {
			return parsedVersion{}, false
		}
		parsed.core[i] = n
	}
	return parsed, true
}

func validIdentifiers(value string) bool {
	if value == "" {
		return false
	}
	for _, identifier := range strings.Split(value, ".") {
		if identifier == "" || strings.IndexFunc(identifier, func(r rune) bool {
			return !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-')
		}) >= 0 {
			return false
		}
	}
	return true
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// cmpPre compares pre-release identifiers dot-segment by dot-segment. Numeric
// segments compare numerically and rank below alphanumeric ones; a shorter
// identifier sorts before an otherwise equal longer one (rc.1 < rc.1.2).
func cmpPre(a, b string) int {
	as := strings.Split(a, ".")
	bs := strings.Split(b, ".")
	for i := 0; i < len(as) && i < len(bs); i++ {
		if as[i] == bs[i] {
			continue
		}
		an, aErr := strconv.Atoi(as[i])
		bn, bErr := strconv.Atoi(bs[i])
		switch {
		case aErr == nil && bErr == nil:
			return cmpInt(an, bn)
		case aErr == nil:
			return -1
		case bErr == nil:
			return 1
		}
		return strings.Compare(as[i], bs[i])
	}
	return cmpInt(len(as), len(bs))
}
