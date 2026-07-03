package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gxShell/backend/types"
)

type Store struct {
	dir string
	mu  sync.RWMutex
}

func NewStore() (*Store, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return nil, err
	}
	return NewStoreAt(filepath.Join(base, "gxShell"))
}

// NewStoreAt builds a Store rooted at an explicit directory. It is used by the
// default NewStore (which resolves the per-user config dir) and by tests that
// need an isolated store under a temp dir.
func NewStoreAt(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0755); err != nil {
		return nil, err
	}
	s := &Store{dir: dir}
	if err := s.ensureDefaults(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) DataDir() string {
	return s.dir
}

func (s *Store) ensureDefaults() error {
	if err := s.ensureJSON("profiles.json", []types.Profile{}); err != nil {
		return err
	}
	if err := s.ensureJSON("commands.json", defaultCommands()); err != nil {
		return err
	}
	return s.ensureJSON("settings.json", DefaultSettings())
}

func (s *Store) ensureJSON(name string, value any) error {
	path := filepath.Join(s.dir, name)
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	return s.writeJSON(name, value)
}

func (s *Store) readJSON(name string, value any) error {
	s.mu.RLock()
	data, err := os.ReadFile(filepath.Join(s.dir, name))
	s.mu.RUnlock()
	if err != nil {
		return err
	}
	if len(data) == 0 {
		return errors.New("empty config file: " + name)
	}
	if err := json.Unmarshal(data, value); err != nil {
		bakData, bakErr := os.ReadFile(filepath.Join(s.dir, name+".bak"))
		if bakErr != nil {
			return fmt.Errorf("failed to parse %s (backup also unavailable): %w", name, err)
		}
		if bakErr := json.Unmarshal(bakData, value); bakErr != nil {
			return fmt.Errorf("failed to parse %s and its backup: %w", name, err)
		}
		s.mu.Lock()
		_ = os.WriteFile(filepath.Join(s.dir, name), bakData, 0600)
		s.mu.Unlock()
	}
	return nil
}

func (s *Store) writeJSON(name string, value any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(s.dir, name+".tmp")
	path := filepath.Join(s.dir, name)
	if existing, err := os.ReadFile(path); err == nil && len(existing) > 0 {
		_ = os.WriteFile(filepath.Join(s.dir, name+".bak"), existing, 0600)
	}
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	var renameErr error
	for i := 0; i < 3; i++ {
		renameErr = os.Rename(tmp, path)
		if renameErr == nil {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	dataCopy, readErr := os.ReadFile(tmp)
	if readErr != nil {
		return renameErr
	}
	_ = os.Remove(tmp)
	return os.WriteFile(path, dataCopy, 0600)
}

func (s *Store) CleanupBackups() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".bak") {
			_ = os.Remove(filepath.Join(s.dir, entry.Name()))
		}
	}
}

func (s *Store) ListProfiles() ([]types.Profile, error) {
	var profiles []types.Profile
	return profiles, s.readJSON("profiles.json", &profiles)
}

func (s *Store) SaveProfiles(profiles []types.Profile) error {
	return s.SaveProfilesPreservingSecrets(profiles, nil)
}

// SaveProfilesPreservingSecrets writes profiles while retaining plaintext
// credentials only for the explicitly listed profile IDs. It exists for startup
// migrations that must keep failed secret migrations retryable; normal callers
// should use SaveProfiles so credentials are never persisted to profiles.json.
func (s *Store) SaveProfilesPreservingSecrets(profiles []types.Profile, preserveSecretIDs map[string]bool) error {
	for i := range profiles {
		if preserveSecretIDs != nil && preserveSecretIDs[profiles[i].ID] {
			continue
		}
		profiles[i].Password = ""
		profiles[i].PrivateKeyPassphrase = ""
	}
	return s.writeJSON("profiles.json", profiles)
}

func (s *Store) GetSettings() (types.AppSettings, error) {
	var settings types.AppSettings
	err := s.readJSON("settings.json", &settings)
	if err != nil {
		return DefaultSettings(), err
	}
	return settings, nil
}

func (s *Store) SaveSettings(settings types.AppSettings) error {
	return s.writeJSON("settings.json", settings)
}

// MigrateSettingsDefaults backfills fields that older settings.json files did
// not contain. JSON unmarshalling cannot distinguish a missing boolean from an
// explicit false, so for keys whose default is true we inspect the raw file:
// only when the key is genuinely absent do we write the default. This runs once
// on startup and is a no-op once those keys have been persisted.
func (s *Store) MigrateSettingsDefaults() {
	s.mu.RLock()
	data, err := os.ReadFile(filepath.Join(s.dir, "settings.json"))
	s.mu.RUnlock()
	if err != nil || len(data) == 0 {
		return
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return
	}
	_, hasCliServerEnabled := raw["cliServerEnabled"]
	_, hasSmartHighlight := raw["smartHighlight"]
	if hasCliServerEnabled && hasSmartHighlight {
		return
	}
	// Start from DefaultSettings and overlay the on-disk file so any field the
	// old file omitted keeps its real default (e.g. fontSize 14, timeout 15)
	// instead of being persisted as a Go zero value. Absent true-by-default
	// booleans then stay true, while explicit false values are preserved.
	settings := DefaultSettings()
	if err := json.Unmarshal(data, &settings); err != nil {
		return
	}
	if !hasCliServerEnabled {
		settings.CliServerEnabled = true
	}
	if !hasSmartHighlight {
		settings.SmartHighlight = true
	}
	_ = s.SaveSettings(settings)
}

// MigrateCommandDefaults appends built-in command templates that older installs
// are missing, while preserving any user-created or edited commands.
func (s *Store) MigrateCommandDefaults() {
	commands, err := s.ListCommands()
	if err != nil {
		return
	}
	seen := map[string]bool{}
	for _, command := range commands {
		key := strings.TrimSpace(command.Command)
		if key != "" {
			seen[key] = true
		}
	}
	changed := false
	for _, command := range defaultCommands() {
		key := strings.TrimSpace(command.Command)
		if key == "" || seen[key] {
			continue
		}
		commands = append(commands, command)
		seen[key] = true
		changed = true
	}
	if changed {
		_ = s.SaveCommands(commands)
	}
}

func (s *Store) ListCommands() ([]types.CommandTemplate, error) {
	var commands []types.CommandTemplate
	return commands, s.readJSON("commands.json", &commands)
}

func (s *Store) SaveCommands(commands []types.CommandTemplate) error {
	return s.writeJSON("commands.json", commands)
}

func DefaultSettings() types.AppSettings {
	return types.AppSettings{
		ThemeName:          "Light",
		MonitorEnabled:     true,
		MonitorIntervalSec: 5,
		ConnectionTimeout:  15,
		SidebarWidth:       300,
		SavePasswords:      false,
		SmartHighlight:     true,
		HighlightLevel:     "off",
		CliServerEnabled:   true,
		Terminal: types.TerminalSettings{
			FontFamily:        "JetBrains Mono, Cascadia Code, Consolas, monospace",
			FontSize:          14,
			LineHeight:        1.25,
			CursorStyle:       "block",
			CursorBlink:       true,
			ThemeName:         "Light",
			BackgroundOpacity: 1,
			ScrollbackLines:   5000,
		},
	}
}

func defaultCommands() []types.CommandTemplate {
	now := time.Now()
	items := []struct {
		name, command, category, desc string
	}{
		{"查看磁盘", "df -h", "系统", "查看磁盘占用"},
		{"查看 Inode", "df -ih", "系统", "查看 inode 使用情况"},
		{"查看内存", "free -h", "系统", "查看内存占用"},
		{"查看负载", "uptime", "系统", "查看系统运行时间和负载"},
		{"CPU 信息", "lscpu", "系统", "查看 CPU 架构与核心信息"},
		{"CPU 占用排行", "ps -eo pid,ppid,user,%cpu,%mem,etime,cmd --sort=-%cpu | head -20", "系统", "查看 CPU 占用最高的进程"},
		{"内存占用排行", "ps -eo pid,ppid,user,%cpu,%mem,etime,cmd --sort=-%mem | head -20", "系统", "查看内存占用最高的进程"},
		{"实时进程快照", "top -b -n 1 | head -40", "系统", "查看当前进程与资源快照"},
		{"系统版本", "uname -a && cat /etc/os-release", "系统", "查看内核与发行版信息"},
		{"登录用户", "who && w", "系统", "查看当前登录用户与会话"},
		{"僵尸进程", "ps aux | awk '$8 ~ /Z/ {print}'", "系统", "查找僵尸进程"},
		{"目录占用 Top", "du -xhd1 /var 2>/dev/null | sort -h", "磁盘", "查看 /var 下一级目录占用"},
		{"大文件 Top", "find / -xdev -type f -size +100M -printf '%s %p\\n' 2>/dev/null | sort -nr | head -20", "磁盘", "查找当前文件系统的大文件"},
		{"Docker 容器", "docker ps", "Docker", "查看运行中的容器"},
		{"Docker 镜像", "docker images", "Docker", "查看镜像列表"},
		{"Docker 资源", "docker stats --no-stream", "Docker", "查看容器资源占用"},
		{"Docker 日志", "docker logs --tail=200 <container>", "Docker", "查看容器最近日志"},
		{"Nginx 状态", "systemctl status nginx", "服务", "查看 Nginx 服务状态"},
		{"Nginx 配置检查", "nginx -t", "服务", "检查 Nginx 配置语法"},
		{"服务状态", "systemctl status <service>", "服务", "查看指定服务状态"},
		{"失败服务", "systemctl --failed", "服务", "查看失败的 systemd 服务"},
		{"服务日志", "journalctl -u <service> -n 200 --no-pager", "日志", "查看指定服务最近日志"},
		{"查看日志", "tail -f /var/log/syslog", "日志", "跟踪系统日志"},
		{"系统告警日志", "journalctl -p warning..alert -n 100 --no-pager", "日志", "查看最近系统告警"},
		{"内核日志", "dmesg -T | tail -100", "日志", "查看最近内核日志"},
		{"查看端口", "ss -tunlp", "网络", "查看监听端口"},
		{"监听端口", "ss -lntup", "网络", "查看 TCP/UDP 监听端口详情"},
		{"连接统计", "ss -s", "网络", "查看 socket 连接统计"},
		{"网络接口", "ip -br addr && ip route", "网络", "查看网卡地址与路由"},
		{"DNS 配置", "resolvectl status || cat /etc/resolv.conf", "网络", "查看 DNS 配置"},
		{"查看进程", "ps aux --sort=-%mem | head", "系统", "查看内存占用最高的进程"},
		{"K8s Pod", "kubectl get pods -A -o wide", "Kubernetes", "查看所有命名空间 Pod"},
		{"K8s 事件", "kubectl get events -A --sort-by=.lastTimestamp | tail -50", "Kubernetes", "查看最近 Kubernetes 事件"},
	}
	commands := make([]types.CommandTemplate, 0, len(items))
	for i, item := range items {
		commands = append(commands, types.CommandTemplate{
			ID:          makeID("cmd", i),
			Name:        item.name,
			Command:     item.command,
			Category:    item.category,
			Description: item.desc,
			Tags:        []string{},
			CreatedAt:   now,
			UpdatedAt:   now,
		})
	}
	return commands
}

func makeID(prefix string, index int) string {
	return types.NewID(prefix)
}
