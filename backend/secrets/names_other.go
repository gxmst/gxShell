//go:build !windows

package secrets

func nativeNamedNames(string) ([]string, error) { return nil, nil }
