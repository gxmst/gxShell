package workflow

import (
	"context"
	"fmt"
	"strings"

	"gxShell/backend/ai"
)

func RunChecks(run Run) []string {
	if run.Workflow == "disk_diagnosis" {
		return []string{"system", "disk", "inodes", "disk_usage", "journal", "container_storage"}
	}
	if run.Workflow == "service_diagnosis" {
		return []string{"system", "services", "ports", "service", "connectivity"}
	}
	return append([]string{}, Checks...)
}

func runQueries(run Run) []Query {
	if run.Workflow == "disk_diagnosis" {
		return []Query{{Check: "system"}, {Check: "disk"}, {Check: "inodes"}, {Check: "disk_usage"}, {Check: "journal"}, {Check: "container_storage"}}
	}
	if run.Workflow == "service_diagnosis" {
		return []Query{{Check: "system"}, {Check: "services"}, {Check: "ports"},
			{Check: "service", Service: run.Service, View: "status"}, {Check: "service", Service: run.Service, View: "logs"},
			{Check: "connectivity", Port: run.Port}}
	}
	queries := []Query{}
	for _, check := range Checks {
		queries = append(queries, Query{Check: check})
	}
	return queries
}

func queryReason(run Run, query Query) string {
	if run.Workflow == "disk_diagnosis" {
		return tr(run.Language, "核对分区、inode、日志和目录占用，定位空间增长来源；目录扫描限时 12 秒。", "Inspect partitions, inodes, journals and bounded directory usage to locate space growth; directory scans stop after 12 seconds.")
	}
	if query.Check == "connectivity" {
		return tr(run.Language, "验证服务器本机回环地址的 TCP 端口是否能连接；不代表外网可访问。", "Test the TCP port on the server's loopback address; this does not prove public reachability.")
	}
	if run.Workflow == "service_diagnosis" && query.Check == "service" {
		return tr(run.Language, "核对所选服务的运行状态与近期日志，排查访问失败原因。", "Read the selected service status and recent logs to investigate the access failure.")
	}
	return tr(run.Language, "按内置流程采集基础证据。", "Collect baseline evidence using the built-in workflow.")
}

func ValidateDiagnosis(service string, port int) error {
	if err := ValidateService(service); err != nil {
		return err
	}
	if port < 1 || port > 65535 {
		return fmt.Errorf("port must be between 1 and 65535")
	}
	return nil
}

func (m *Manager) StartDiagnosis(parentContext context.Context, sessionID, profileID, target, language string, cfg ai.Config, service string, port int) (Run, error) {
	if err := ValidateDiagnosis(service, port); err != nil {
		return Run{}, err
	}
	return m.start(parentContext, sessionID, profileID, target, language, cfg, "service_diagnosis", service, port)
}

func diagnosisInstructions(run Run) string {
	if run.Workflow == "disk_diagnosis" {
		return "Investigate disk space pressure using partition usage, inode usage, the fixed directory scan, journal size and Docker storage summary. Directory scans are bounded to 12 seconds and fixed scopes; GXSHELL_ABSENT=<path> means that directory does not exist on this host and was skipped, which is not a fault; partial/permission-denied scans are unknown. Distinguish filesystem fullness, inode exhaustion, journal growth and Docker storage; never recommend deleting unknown data, active logs or volumes. No cleanup is performed in diagnosis. Use inspect_disk only for the fixed scope enum. "
	}
	if run.Workflow != "service_diagnosis" {
		return ""
	}
	return fmt.Sprintf("Investigate why service %s on TCP port %d cannot be accessed. The port probe tests only 127.0.0.1 from inside the server. Never infer external reachability, firewall state, DNS or the port owner from a TCP connection alone. Differentiate failed/not-found service, absent listener, local refusal, and unknown external path. Do not assume the named service owns the specified port. ", run.Service, run.Port)
}

func queryView(language, view string) string {
	switch strings.TrimSpace(view) {
	case "status":
		return tr(language, "状态", "Status")
	case "logs":
		return tr(language, "日志", "Logs")
	default:
		return view
	}
}
