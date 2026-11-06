//go:build windows

package workflow

import (
	"errors"
	"os"
	"syscall"
	"time"
)

// Windows scanners may briefly open either file without FILE_SHARE_DELETE.
// Retry only the two resulting rename errors; never delete the destination or
// retry the workflow itself. Persistent failures still reach the caller.
func replaceHistoryFile(source, destination string) error {
	var err error
	for attempt := 0; attempt <= 5; attempt++ {
		if err = os.Rename(source, destination); err == nil {
			return nil
		}
		if !errors.Is(err, syscall.ERROR_ACCESS_DENIED) && !errors.Is(err, syscall.Errno(32)) {
			return err
		}
		if attempt < 5 {
			time.Sleep(time.Duration(10<<attempt) * time.Millisecond)
		}
	}
	return err
}
