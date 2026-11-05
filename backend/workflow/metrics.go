package workflow

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var loadValues = regexp.MustCompile(`load averages?:\s*([0-9.]+),?\s+([0-9.]+),?\s+([0-9.]+)`)

// Keep the source values separate from the model's interpretation.
func observedValues(e Evidence, language string) string {
	if e.Status != "collected" || e.Truncated {
		return ""
	}
	switch e.Query.Check {
	case "load":
		values := loadValues.FindStringSubmatch(e.Output)
		if len(values) == 4 {
			return strings.Join(values[1:], " / ")
		}
	case "memory":
		for _, line := range strings.Split(e.Output, "\n") {
			f := strings.Fields(line)
			if len(f) >= 7 && f[0] == "Mem:" {
				valid := true
				for _, n := range []string{f[1], f[2], f[6]} {
					if _, err := strconv.ParseUint(n, 10, 64); err != nil {
						valid = false
					}
				}
				if valid {
					return fmt.Sprintf("%s %s / %s MiB · %s %s MiB", tr(language, "已用", "Used"), f[2], f[1], tr(language, "可用", "Available"), f[6])
				}
			}
		}
	case "disk":
		maxPercent := -1
		mount := ""
		for _, line := range strings.Split(e.Output, "\n") {
			f := strings.Fields(line)
			if len(f) < 6 {
				continue
			}
			n, err := strconv.Atoi(strings.TrimSuffix(f[4], "%"))
			if err == nil && n >= 0 && n <= 100 && strings.HasSuffix(f[4], "%") && n > maxPercent {
				maxPercent = n
				mount = f[5]
			}
		}
		if maxPercent >= 0 {
			return fmt.Sprintf("%s · %d%%", mount, maxPercent)
		}
	}
	return ""
}
