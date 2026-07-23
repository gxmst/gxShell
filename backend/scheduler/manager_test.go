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
		if err := validateJob(schedule, "echo ok"); err != nil {
			t.Errorf("valid schedule %q: %v", schedule, err)
		}
	}
	for _, schedule := range []string{"* * * *", "@sometimes", "* * * * *;id"} {
		if err := validateJob(schedule, "echo ok"); err == nil {
			t.Errorf("invalid schedule %q accepted", schedule)
		}
	}
	if err := validateJob("@daily", "echo a\necho b"); err == nil {
		t.Fatal("multiline command accepted")
	}
}
