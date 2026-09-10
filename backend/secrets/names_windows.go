package secrets

import (
	"errors"
	"strings"
	"syscall"

	"github.com/danieljoos/wincred"
)

func nativeNamedNames(namespace string) ([]string, error) {
	prefix := service + ":named:" + namespace + ":"
	entries, err := wincred.FilteredList(prefix + "*")
	if errors.Is(err, syscall.ERROR_NOT_FOUND) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var names []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.TargetName, prefix) && strings.HasSuffix(entry.TargetName, ".value") {
			names = append(names, strings.TrimSuffix(strings.TrimPrefix(entry.TargetName, prefix), ".value"))
		}
	}
	return names, nil
}
