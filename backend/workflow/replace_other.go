//go:build !windows

package workflow

import "os"

func replaceHistoryFile(source, destination string) error { return os.Rename(source, destination) }
