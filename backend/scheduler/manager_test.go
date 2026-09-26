package scheduler

import "testing"

func TestParseCronJobsPreservesEnabledStateAndCommands(t *testing.T) {
	lines := []string{
		"SHELL=/bin/bash",
		"# comment",
		"*/5 * * * * /usr/local/bin/check --flag 'two words'",
		"# gxShell-disabled: @daily /opt/backup.sh",
	}
	jobs := parseCronJobs(lines)
	if len(jobs) != 2 {
		t.Fatalf("jobs = %#v", jobs)
	}
	if jobs[0].Schedule != "*/5 * * * *" || jobs[0].Command != "/usr/local/bin/check --flag 'two words'" || !jobs[0].Enabled {
		t.Fatalf("first job = %+v", jobs[0])
	}
	if jobs[1].Schedule != "@daily" || jobs[1].Command != "/opt/backup.sh" || jobs[1].Enabled {
		t.Fatalf("second job = %+v", jobs[1])
	}
	if findJobLine(lines, jobs[1].ID) != 3 {
		t.Fatal("disabled job id did not resolve to its source line")
	}
}

func TestValidateJob(t *testing.T) {
	for _, schedule := range []string{"*/5 * * * *", "0 3 * * 1-5", "@reboot"} {
		if err := validateJob(schedule, "echo ok", "en"); err != nil {
			t.Errorf("valid schedule %q: %v", schedule, err)
		}
	}
	for _, schedule := range []string{"* * * *", "@sometimes", "* * * * *;id"} {
		if err := validateJob(schedule, "echo ok", "en"); err == nil {
			t.Errorf("invalid schedule %q accepted", schedule)
		}
	}
	if err := validateJob("@daily", "echo a\necho b", "en"); err == nil {
		t.Fatal("multiline command accepted")
	}
}

// A rejected schedule is shown to the user verbatim, so each reason has to
// follow the interface language. Checking one message per branch is enough to
// catch a branch that was left rendering the Chinese pair unconditionally.
func TestValidateJobMessagesFollowLanguage(t *testing.T) {
	cases := []struct {
		name     string
		schedule string
		command  string
		zh       string
		en       string
	}{
		{
			name:     "bad command",
			schedule: "*/5 * * * *",
			command:  "",
			zh:       "任务命令不能为空、不能换行，且长度不能超过 8192 个字符",
			en:       "The job command must not be empty, must not contain newlines, and must not exceed 8192 characters",
		},
		{
			name:     "unknown macro",
			schedule: "@sometimes",
			command:  "echo ok",
			zh:       "不支持的计划表达式",
			en:       "Unsupported schedule expression",
		},
		{
			name:     "wrong field count",
			schedule: "* * * *",
			command:  "echo ok",
			zh:       "Cron 表达式必须包含 5 个字段",
			en:       "The cron expression must contain 5 fields",
		},
		{
			name:     "invalid character",
			schedule: "* * * * *;id",
			command:  "echo ok",
			zh:       "Cron 表达式包含无效字符",
			en:       "The cron expression contains invalid characters",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validateJob(tc.schedule, tc.command, "zh-CN")
			if err == nil || err.Error() != tc.zh {
				t.Fatalf("zh error = %v, want %q", err, tc.zh)
			}
			err = validateJob(tc.schedule, tc.command, "en")
			if err == nil || err.Error() != tc.en {
				t.Fatalf("en error = %v, want %q", err, tc.en)
			}
		})
	}
}
