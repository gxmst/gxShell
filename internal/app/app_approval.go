package app

import (
	"fmt"
	"strings"
)

func formatApprovalList(items []string) string {
	if len(items) == 0 {
		return ""
	}
	lines := make([]string, 0, len(items))
	for i := range items {
		lines = append(lines, fmt.Sprintf("%d. %s", i+1, items[i]))
	}
	return strings.Join(lines, "\n\n")
}
