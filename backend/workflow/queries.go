package workflow

import (
	"fmt"
	"regexp"
)

var serviceName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$`)

func ValidateService(name string) error {
	if !serviceName.MatchString(name) {
		return fmt.Errorf("invalid service name")
	}
	return nil
}

// Command is the only place queries become commands. Neither templates nor the
// model can supply arbitrary shell text, paths, substitutions or environment.
func Command(query Query) (string, error) {
	if query.Check == "disk_usage" && query.Service == "" && query.View == "" && query.Port == 0 {
		return diskUsageCommand(query.Scope)
	}
	if query.Scope != "" {
		return "", fmt.Errorf("unexpected disk scope")
	}
	if query.Check == "connectivity" {
		if query.Port < 1 || query.Port > 65535 || query.Service != "" || query.View != "" {
			return "", fmt.Errorf("invalid connectivity query")
		}
		return fmt.Sprintf("if command -v nc >/dev/null 2>&1; then nc -z -w 3 127.0.0.1 %d; result=$?; elif command -v timeout >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then timeout 4 bash -c 'exec 3<>/dev/tcp/127.0.0.1/%d'; result=$?; else echo 'No supported TCP probe'; exit 127; fi; if [ \"$result\" -eq 0 ]; then echo 'GXSHELL_TCP=reachable'; else echo 'GXSHELL_TCP=unreachable'; fi; exit \"$result\"", query.Port, query.Port), nil
	}
	if query.Port != 0 {
		return "", fmt.Errorf("unexpected port argument")
	}
	if query.Check == "service" {
		if err := ValidateService(query.Service); err != nil {
			return "", err
		}
		switch query.View {
		case "status":
			return "systemctl show --no-pager --property=LoadState,ActiveState,SubState,Result,ExecMainStatus -- '" + query.Service + "'", nil
		case "logs":
			return "journalctl --no-pager -n 80 -u '" + query.Service + "'", nil
		default:
			return "", fmt.Errorf("unsupported service view")
		}
	}
	if query.Service != "" || query.View != "" {
		return "", fmt.Errorf("unexpected check arguments")
	}
	switch query.Check {
	case "system":
		return "uname -srm && getconf _NPROCESSORS_ONLN && cat /etc/os-release", nil
	case "load":
		return "uptime", nil
	case "disk":
		return "df -Pk", nil
	case "inodes":
		return "df -Pi", nil
	case "journal":
		return "journalctl --disk-usage", nil
	case "container_storage":
		return "docker system df", nil
	case "memory":
		return "if command -v free >/dev/null 2>&1; then free -m; else cat /proc/meminfo; fi", nil
	case "services":
		return "if command -v systemctl >/dev/null 2>&1; then echo 'GXSHELL_SERVICE_MANAGER=systemd'; systemctl --failed --no-legend --no-pager; elif command -v rc-status >/dev/null 2>&1; then echo 'GXSHELL_SERVICE_MANAGER=openrc'; rc-status -a; else echo 'No supported service manager'; exit 127; fi", nil
	case "ports":
		return "if command -v ss >/dev/null 2>&1; then ss -lntp; else netstat -lntp; fi", nil
	case "containers":
		return "docker ps -a --format '{{.Names}}\\t{{.Status}}\\t{{.Ports}}'", nil
	default:
		return "", fmt.Errorf("unsupported inspection query")
	}
}
