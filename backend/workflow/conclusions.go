package workflow

import (
	"fmt"
	"sort"
	"strings"
)

func measuredConclusion(run Run, e Evidence) (status, reading string) {
	if e.Status != "collected" || e.Truncated {
		return
	}
	if e.Query.Check == "disk" || e.Query.Check == "inodes" {
		values := diskValues(e)
		mounts := []string{}
		for m := range values {
			mounts = append(mounts, m)
		}
		sort.Strings(mounts)
		max := 0
		mount := ""
		for _, m := range mounts {
			if values[m].percent > max {
				max = values[m].percent
				mount = m
			}
		}
		if max >= 90 {
			status = "warning"
			if max >= 95 {
				status = "critical"
			}
			reading = fmt.Sprintf(tr(run.Language, "%s 使用率 %d%%，需要核实占用来源。", "%s usage is %d%%; verify the source of consumption."), mount, max)
		}
	}
	if e.Query.Check == "service" && run.Workflow == "service_diagnosis" && e.Query.View == "status" {
		switch {
		case strings.Contains(e.Output, "LoadState=not-found"), strings.Contains(e.Output, "ActiveState=failed"):
			status = "critical"
			reading = tr(run.Language, "所选服务不存在或处于失败状态。", "The selected service is missing or failed.")
		case strings.Contains(e.Output, "ActiveState=inactive"):
			status = "warning"
			reading = tr(run.Language, "所选服务当前未运行，需要核实是否符合预期。", "The selected service is inactive; verify whether that is expected.")
		}
	}
	if e.Query.Check == "connectivity" && strings.Contains(e.Output, "GXSHELL_TCP=unreachable") {
		status = "critical"
		reading = tr(run.Language, "服务器本机 TCP 连接未成功，外网连通性仍未确认。", "The local TCP connection did not succeed; public reachability remains unconfirmed.")
	}
	return
}
