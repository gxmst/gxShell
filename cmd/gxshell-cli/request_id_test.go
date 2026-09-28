package main

import "testing"

func TestRequestIDScope(t *testing.T) {
	for _, command := range []string{"exec", "exec-file", "exec-stdin", "copy", "transfer", "tunnel", "secret", "job", "ping"} {
		want := command == "exec" || command == "exec-file" || command == "exec-stdin"
		if err := validateRequestIDScope(cliOptions{command: command, requestID: "retry-1"}); (err == nil) != want {
			t.Fatalf("command %s: %v", command, err)
		}
		if err := validateRequestIDScope(cliOptions{command: command}); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOptionalRequestIDParsing(t *testing.T) {
	for _, args := range [][]string{
		{"--request-id", "deploy-1", "exec", "web", "true"},
		{"exec", "web", "true", "--request-id", "deploy-1"},
	} {
		rest, opts, err := parseLeadingFlags(args, cliOptions{})
		if err != nil {
			t.Fatal(err)
		}
		rest, opts, err = stripTrailingFlags(rest, opts)
		if err != nil || opts.requestID != "deploy-1" || len(rest) != 3 {
			t.Fatalf("rest=%v opts=%+v err=%v", rest, opts, err)
		}
	}
	for _, id := range []string{"", "bad id", "line\nbreak"} {
		if _, _, err := parseLeadingFlags([]string{"--request-id", id}, cliOptions{}); err == nil {
			t.Fatalf("accepted %q", id)
		}
	}
}
