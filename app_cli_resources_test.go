package main

import "testing"

func TestNormalizeCliLoopbackEndpoint(t *testing.T) {
	for _, input := range []string{"0", "1080", "127.0.0.1:8080", "[::1]:0", "localhost:9000"} {
		if _, err := normalizeCliLoopbackEndpoint(input); err != nil {
			t.Errorf("%q rejected: %v", input, err)
		}
	}
	for _, input := range []string{"0.0.0.0:8080", "192.0.2.10:8080", "[::]:8080", "bad"} {
		if _, err := normalizeCliLoopbackEndpoint(input); err == nil {
			t.Errorf("%q should be rejected", input)
		}
	}
}

func TestValidateCliRemoteEndpoint(t *testing.T) {
	if err := validateCliRemoteEndpoint("127.0.0.1:80"); err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{"localhost", ":80", "host:0", "host:70000"} {
		if err := validateCliRemoteEndpoint(input); err == nil {
			t.Errorf("%q should be rejected", input)
		}
	}
}
