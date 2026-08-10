package app

import (
	"os/exec"
	"strings"
	"testing"

	"gxShell/backend/types"
)

func TestPostConnectScriptEmptyProfileProducesNothing(t *testing.T) {
	if lines := postConnectScript(types.Profile{}); len(lines) != 0 {
		t.Fatalf("expected no lines, got %#v", lines)
	}
}

func TestPostConnectScriptOrdersDirectoryThenEnvThenCommands(t *testing.T) {
	profile := types.Profile{
		StartDirectory: "/srv/app",
		Environment:    []string{"NODE_ENV=production"},
		LoginCommands:  []string{"source .venv/bin/activate"},
	}
	lines := postConnectScript(profile)
	want := []string{
		"cd '/srv/app'",
		"export NODE_ENV='production'",
		"source .venv/bin/activate",
	}
	if len(lines) != len(want) {
		t.Fatalf("got %d lines, want %d: %#v", len(lines), len(want), lines)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Errorf("line %d = %q, want %q", i, lines[i], want[i])
		}
	}
}

func TestPostConnectPayloadCombinesActionsIntoOneWrite(t *testing.T) {
	payload := postConnectPayload(types.Profile{
		StartDirectory: "/srv/app",
		Environment:    []string{"NODE_ENV=production"},
		LoginCommands:  []string{"source .venv/bin/activate"},
	})
	want := "cd '/srv/app'\nexport NODE_ENV='production'\nsource .venv/bin/activate\n"
	if payload != want {
		t.Fatalf("payload = %q, want %q", payload, want)
	}
}

// The start directory is quoted, so a value carrying shell metacharacters
// becomes one (nonsensical) path rather than a second command. This is the
// property that makes the field safe to expose in the UI.
func TestPostConnectScriptQuotesStartDirectory(t *testing.T) {
	cases := []struct{ dir, want string }{
		{"/tmp; rm -rf ~", "cd '/tmp; rm -rf ~'"},
		{"/var/log/my app", "cd '/var/log/my app'"},
		{"/srv/$(whoami)", "cd '/srv/$(whoami)'"},
		{"/srv/`id`", "cd '/srv/`id`'"},
		{"/srv/a&&b", "cd '/srv/a&&b'"},
		{"/it's/here", `cd '/it'\''s/here'`},
	}
	for _, c := range cases {
		lines := postConnectScript(types.Profile{StartDirectory: c.dir})
		if len(lines) != 1 {
			t.Fatalf("StartDirectory %q produced %#v", c.dir, lines)
		}
		if lines[0] != c.want {
			t.Errorf("StartDirectory %q -> %q, want %q", c.dir, lines[0], c.want)
		}
	}
}

func TestPostConnectScriptQuotesEnvironmentValues(t *testing.T) {
	lines := postConnectScript(types.Profile{Environment: []string{
		"TOKEN_STYLE=a b; echo hi",
		"QUOTED=it's",
		"EMPTY=",
		"WITH_EQUALS=key=value",
	}})
	want := []string{
		"export TOKEN_STYLE='a b; echo hi'",
		`export QUOTED='it'\''s'`,
		"export EMPTY=''",
		"export WITH_EQUALS='key=value'",
	}
	if len(lines) != len(want) {
		t.Fatalf("got %#v, want %#v", lines, want)
	}
	for i := range want {
		if lines[i] != want[i] {
			t.Errorf("line %d = %q, want %q", i, lines[i], want[i])
		}
	}
}

func TestPostConnectScriptSkipsMalformedEnvironmentEntries(t *testing.T) {
	for _, entry := range []string{
		"",
		"NOEQUALS",
		"=novalue",
		"has space=x",
		"1STARTSWITHDIGIT=x",
		"HAS-DASH=x",
		"HAS.DOT=x",
		"$(id)=x",
	} {
		if lines := postConnectScript(types.Profile{Environment: []string{entry}}); len(lines) != 0 {
			t.Errorf("entry %q should have been skipped, got %#v", entry, lines)
		}
	}
}

// Newlines and control bytes must not survive: one configured value turning into
// two lines of terminal input would sidestep the quoting entirely.
func TestPostConnectScriptStripsControlCharacters(t *testing.T) {
	lines := postConnectScript(types.Profile{
		StartDirectory: "/srv\nrm -rf ~",
		Environment:    []string{"A=one\rtwo"},
		LoginCommands:  []string{"echo hi\nrm -rf ~"},
	})
	for _, line := range lines {
		if strings.ContainsAny(line, "\n\r") {
			t.Fatalf("line still contains a newline: %q", line)
		}
	}
	if lines[0] != "cd '/srvrm -rf ~'" {
		t.Errorf("start directory = %q", lines[0])
	}
	if lines[1] != "export A='onetwo'" {
		t.Errorf("env = %q", lines[1])
	}
	// The login command is raw by design, but must still be a single line.
	if lines[2] != "echo hirm -rf ~" {
		t.Errorf("login command = %q", lines[2])
	}
}

// Login commands are intentionally NOT quoted: the user wrote a command line and
// expects pipes and redirection to work.
func TestPostConnectScriptLeavesLoginCommandsUnquoted(t *testing.T) {
	lines := postConnectScript(types.Profile{LoginCommands: []string{
		"tail -f /var/log/syslog | grep -i error",
		"cd /srv && ls -la",
	}})
	if lines[0] != "tail -f /var/log/syslog | grep -i error" {
		t.Errorf("pipeline was altered: %q", lines[0])
	}
	if lines[1] != "cd /srv && ls -la" {
		t.Errorf("command list was altered: %q", lines[1])
	}
}

func TestPostConnectScriptSkipsBlankEntries(t *testing.T) {
	lines := postConnectScript(types.Profile{
		StartDirectory: "   ",
		LoginCommands:  []string{"", "   ", "\t"},
	})
	if len(lines) != 0 {
		t.Fatalf("blank entries should produce nothing, got %#v", lines)
	}
}

func TestPostConnectScriptCapsCommandCount(t *testing.T) {
	many := make([]string, maxPostConnectCommands+10)
	for i := range many {
		many[i] = "echo line"
	}
	lines := postConnectScript(types.Profile{LoginCommands: many})
	if len(lines) != maxPostConnectCommands {
		t.Fatalf("got %d lines, want the cap of %d", len(lines), maxPostConnectCommands)
	}
}

func TestSingleQuoteEscapingRoundTrips(t *testing.T) {
	// Verifies the escaping rule itself: the quoted form of any value must be a
	// single shell word whose content is exactly the original.
	for _, value := range []string{
		"plain",
		"with space",
		"it's",
		`double"quote`,
		"$HOME",
		"`id`",
		"a'b'c",
		`back\slash`,
	} {
		quoted := singleQuote(value)
		if !strings.HasPrefix(quoted, "'") || !strings.HasSuffix(quoted, "'") {
			t.Errorf("singleQuote(%q) = %q, not single-quoted", value, quoted)
		}
		// Reverse the escaping the way a POSIX shell would: strip the outer
		// quotes, then collapse the '\'' sequences back to a bare quote.
		inner := strings.TrimSuffix(strings.TrimPrefix(quoted, "'"), "'")
		if got := strings.ReplaceAll(inner, `'\''`, "'"); got != value {
			t.Errorf("singleQuote(%q) does not round-trip: got %q", value, got)
		}
	}
}

// The test above checks singleQuote against a reimplementation of the shell's
// unquoting rules, which would agree with itself even if both were wrong. This
// one hands the quoted value to a real POSIX shell and asks what it saw. The
// remote end is always a POSIX shell, so this is the behaviour that matters.
func TestSingleQuoteAgainstRealShell(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no POSIX sh available to verify quoting against")
	}

	for _, value := range []string{
		"plain",
		"with space",
		"it's",
		`double"quote`,
		"$HOME",
		"`id`",
		"$(id)",
		"a'b'c",
		`back\slash`,
		"semi;colon",
		"pipe|char",
		"amp&ersand",
		"glob*star",
		"new\tline-tab",
		"quote'at-end'",
		"'leading-quote",
	} {
		// printf %s echoes exactly one argument with no added newline, so any
		// difference is the shell having split, expanded or substituted the word.
		out, err := exec.Command(sh, "-c", "printf %s "+singleQuote(value)).Output()
		if err != nil {
			t.Fatalf("sh rejected the quoted form of %q: %v", value, err)
		}
		if string(out) != value {
			t.Errorf("sh saw %q for input %q (quoted as %s)", out, value, singleQuote(value))
		}
	}
}

// A start directory or environment value must not be able to run a second
// command, which is the failure this whole quoting scheme exists to prevent.
func TestPostConnectValuesCannotInjectCommands(t *testing.T) {
	sh, err := exec.LookPath("sh")
	if err != nil {
		t.Skip("no POSIX sh available to verify quoting against")
	}

	// If quoting fails, the injected `echo pwned` runs and appears in the output.
	for _, hostile := range []string{
		"/tmp; echo pwned",
		"/tmp && echo pwned",
		"/tmp$(echo pwned)",
		"/tmp`echo pwned`",
		"/tmp | echo pwned",
	} {
		out, err := exec.Command(sh, "-c", "printf %s "+singleQuote(hostile)).Output()
		if err != nil {
			t.Fatalf("sh rejected %q: %v", hostile, err)
		}
		if strings.Contains(string(out), "pwned\n") || string(out) != hostile {
			t.Errorf("value %q was not fully quoted: sh produced %q", hostile, out)
		}
	}
}
