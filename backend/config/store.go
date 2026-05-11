package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
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
	dir := filepath.Join(base, "gxShell")
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
	return s.ensureJSON("settings.json", defaultSettings())
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
			return err
		}
		if bakErr := json.Unmarshal(bakData, value); bakErr != nil {
			return err
		}
		_ = os.WriteFile(filepath.Join(s.dir, name), bakData, 0600)
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
	return os.Rename(tmp, path)
}

func (s *Store) ListProfiles() ([]types.Profile, error) {
	var profiles []types.Profile
	return profiles, s.readJSON("profiles.json", &profiles)
}

func (s *Store) SaveProfiles(profiles []types.Profile) error {
	for i := range profiles {
		profiles[i].Password = ""
		profiles[i].PrivateKeyPassphrase = ""
	}
	return s.writeJSON("profiles.json", profiles)
}

func (s *Store) GetSettings() (types.AppSettings, error) {
	var settings types.AppSettings
	return settings, s.readJSON("settings.json", &settings)
}

func (s *Store) SaveSettings(settings types.AppSettings) error {
	return s.writeJSON("settings.json", settings)
}

func (s *Store) ListCommands() ([]types.CommandTemplate, error) {
	var commands []types.CommandTemplate
	return commands, s.readJSON("commands.json", &commands)
}

func (s *Store) SaveCommands(commands []types.CommandTemplate) error {
	return s.writeJSON("commands.json", commands)
}

func defaultSettings() types.AppSettings {
	return types.AppSettings{
		ThemeName:          "gx-dark",
		MonitorEnabled:     true,
		MonitorIntervalSec: 5,
		ConnectionTimeout:  15,
		SidebarWidth:       300,
		SavePasswords:      false,
		SmartHighlight:     false,
		Terminal: types.TerminalSettings{
			FontFamily:        "JetBrains Mono, Cascadia Code, Consolas, monospace",
			FontSize:          14,
			LineHeight:        1.25,
			CursorStyle:       "block",
			CursorBlink:       true,
			ThemeName:         "gx Dark",
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
		{"查看内存", "free -h", "系统", "查看内存占用"},
		{"查看负载", "uptime", "系统", "查看系统运行时间和负载"},
		{"Docker 容器", "docker ps", "Docker", "查看运行中的容器"},
		{"Docker 镜像", "docker images", "Docker", "查看镜像列表"},
		{"Nginx 状态", "systemctl status nginx", "服务", "查看 Nginx 服务状态"},
		{"服务状态", "systemctl status <service>", "服务", "查看指定服务状态"},
		{"查看日志", "tail -f /var/log/syslog", "日志", "跟踪系统日志"},
		{"查看端口", "ss -tunlp", "网络", "查看监听端口"},
		{"查看进程", "ps aux --sort=-%mem | head", "系统", "查看内存占用最高的进程"},
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
	return prefix + "-" + time.Now().Format("20060102150405") + "-" + string(rune('a'+index))
}
