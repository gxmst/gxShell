package scheduler

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"time"

	"gxShell/backend/types"
)

type schedulerSSH interface {
	Exec(sessionID, command string, timeout time.Duration) (string, error)
}

type Manager struct {
	ssh schedulerSSH
}

func NewManager(ssh schedulerSSH) *Manager { return &Manager{ssh: ssh} }

const disabledPrefix = "# gxShell-disabled: "

var (
	cronFieldRe = regexp.MustCompile(`^[A-Za-z0-9*/?,#L\-]+$`)
	cronMacros  = map[string]bool{
		"@reboot": true, "@yearly": true, "@annually": true,
		"@monthly": true, "@weekly": true, "@daily": true,
		"@midnight": true, "@hourly": true,
	}
)

func (m *Manager) List(sessionID string) ([]types.CronJob, error) {
	lines, err := m.readLines(sessionID)
	if err != nil {
		return nil, err
	}
	return parseCronJobs(lines), nil
}

func (m *Manager) Save(sessionID, id, schedule, command string, enabled bool) error {
	schedule = strings.TrimSpace(schedule)
	command = strings.TrimSpace(command)
	if err := validateJob(schedule, command); err != nil {
		return err
	}
	lines, err := m.readLines(sessionID)
	if err != nil {
		return err
	}
	line := schedule + " " + command
	if !enabled {
		line = disabledPrefix + line
	}
	if id == "" {
		if len(lines) > 0 && strings.TrimSpace(lines[len(lines)-1]) != "" {
			lines = append(lines, "")
		}
		lines = append(lines, line)
	} else {
		index := findJobLine(lines, id)
		if index < 0 {
			return fmt.Errorf("计划任务已发生变化，请刷新后重试")
		}
		lines[index] = line
	}
	return m.writeLines(sessionID, lines)
}

func (m *Manager) Delete(sessionID, id string) error {
	lines, err := m.readLines(sessionID)
	if err != nil {
		return err
	}
	index := findJobLine(lines, id)
	if index < 0 {
		return fmt.Errorf("计划任务已发生变化，请刷新后重试")
	}
	lines = append(lines[:index], lines[index+1:]...)
	return m.writeLines(sessionID, lines)
}

func (m *Manager) SetEnabled(sessionID, id string, enabled bool) error {
	lines, err := m.readLines(sessionID)
	if err != nil {
		return err
	}
	index := findJobLine(lines, id)
	if index < 0 {
		return fmt.Errorf("计划任务已发生变化，请刷新后重试")
	}
	raw := strings.TrimSpace(lines[index])
	currentlyEnabled := !strings.HasPrefix(raw, disabledPrefix)
	if enabled == currentlyEnabled {
		return nil
	}
	if enabled {
		lines[index] = strings.TrimPrefix(raw, disabledPrefix)
	} else {
		lines[index] = disabledPrefix + raw
	}
	return m.writeLines(sessionID, lines)
}

func (m *Manager) Run(sessionID, id string) (string, error) {
	lines, err := m.readLines(sessionID)
	if err != nil {
		return "", err
	}
	jobs := parseCronJobs(lines)
	for _, job := range jobs {
		if job.ID == id {
			out, runErr := m.ssh.Exec(sessionID, job.Command, 5*time.Minute)
			if runErr != nil {
				if strings.TrimSpace(out) != "" {
					return out, fmt.Errorf("计划任务执行失败: %v: %s", runErr, strings.TrimSpace(out))
				}
				return out, fmt.Errorf("计划任务执行失败: %w", runErr)
			}
			return out, nil
		}
	}
	return "", fmt.Errorf("计划任务已发生变化，请刷新后重试")
}

func (m *Manager) readLines(sessionID string) ([]string, error) {
	cmd := `command -v crontab >/dev/null 2>&1 || { echo __GX_NO_CRONTAB__; exit 127; }; crontab -l 2>/dev/null || true`
	out, err := m.ssh.Exec(sessionID, cmd, 20*time.Second)
	if err != nil {
		if strings.Contains(out, "__GX_NO_CRONTAB__") || strings.Contains(strings.ToLower(err.Error()), "127") {
			return nil, fmt.Errorf("远程主机未安装 crontab")
		}
		return nil, err
	}
	out = strings.ReplaceAll(out, "\r\n", "\n")
	out = strings.TrimSuffix(out, "\n")
	if out == "" {
		return []string{}, nil
	}
	return strings.Split(out, "\n"), nil
}

func (m *Manager) writeLines(sessionID string, lines []string) error {
	content := strings.Join(lines, "\n")
	if content != "" && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	payload := base64.StdEncoding.EncodeToString([]byte(content))
	cmd := "printf '%s' '" + payload + "' | base64 -d | crontab -"
	out, err := m.ssh.Exec(sessionID, cmd, 20*time.Second)
	if err != nil {
		if strings.TrimSpace(out) != "" {
			return fmt.Errorf("保存计划任务失败: %v: %s", err, strings.TrimSpace(out))
		}
		return fmt.Errorf("保存计划任务失败: %w", err)
	}
	return nil
}

func parseCronJobs(lines []string) []types.CronJob {
	jobs := make([]types.CronJob, 0)
	seen := make(map[string]int)
	for _, original := range lines {
		raw := strings.TrimSpace(original)
		if raw == "" {
			continue
		}
		enabled := true
		if strings.HasPrefix(raw, disabledPrefix) {
			enabled = false
			raw = strings.TrimSpace(strings.TrimPrefix(raw, disabledPrefix))
		} else if strings.HasPrefix(raw, "#") {
			continue
		}
		schedule, command, ok := splitCronLine(raw)
		if !ok {
			continue
		}
		occurrence := seen[raw]
		seen[raw] = occurrence + 1
		jobs = append(jobs, types.CronJob{
			ID:       cronJobID(raw, occurrence),
			Schedule: schedule,
			Command:  command,
			Enabled:  enabled,
		})
	}
	return jobs
}

func splitCronLine(raw string) (string, string, bool) {
	fields := strings.Fields(raw)
	if len(fields) < 2 {
		return "", "", false
	}
	if strings.HasPrefix(fields[0], "@") {
		if !cronMacros[strings.ToLower(fields[0])] {
			return "", "", false
		}
		return fields[0], strings.TrimSpace(strings.TrimPrefix(raw, fields[0])), true
	}
	if len(fields) < 6 {
		return "", "", false
	}
	schedule := strings.Join(fields[:5], " ")
	// Locate the command after the fifth field without normalizing its spacing.
	rest := raw
	for i := 0; i < 5; i++ {
		rest = strings.TrimLeft(rest, " \t")
		pos := strings.IndexAny(rest, " \t")
		if pos < 0 {
			return "", "", false
		}
		rest = rest[pos:]
	}
	return schedule, strings.TrimSpace(rest), strings.TrimSpace(rest) != ""
}

func validateJob(schedule, command string) error {
	if command == "" || len(command) > 8192 || strings.ContainsAny(command, "\r\n\x00") {
		return fmt.Errorf("任务命令不能为空、不能换行，且长度不能超过 8192 个字符")
	}
	if strings.HasPrefix(schedule, "@") {
		if !cronMacros[strings.ToLower(schedule)] {
			return fmt.Errorf("不支持的计划表达式")
		}
		return nil
	}
	fields := strings.Fields(schedule)
	if len(fields) != 5 {
		return fmt.Errorf("Cron 表达式必须包含 5 个字段")
	}
	for _, field := range fields {
		if !cronFieldRe.MatchString(field) {
			return fmt.Errorf("Cron 表达式包含无效字符")
		}
	}
	return nil
}

func cronJobID(raw string, occurrence int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d", raw, occurrence)))
	return hex.EncodeToString(sum[:8])
}

func findJobLine(lines []string, id string) int {
	seen := make(map[string]int)
	for index, original := range lines {
		raw := strings.TrimSpace(original)
		if strings.HasPrefix(raw, disabledPrefix) {
			raw = strings.TrimSpace(strings.TrimPrefix(raw, disabledPrefix))
		} else if raw == "" || strings.HasPrefix(raw, "#") {
			continue
		}
		if _, _, ok := splitCronLine(raw); !ok {
			continue
		}
		occurrence := seen[raw]
		seen[raw] = occurrence + 1
		if cronJobID(raw, occurrence) == id {
			return index
		}
	}
	return -1
}
