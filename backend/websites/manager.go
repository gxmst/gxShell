package websites

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"gxShell/backend/types"
)

type websiteSSH interface {
	Exec(sessionID, command string, timeout time.Duration) (string, error)
}

type Manager struct {
	ssh       websiteSSH
	rootMu    sync.Mutex
	rootCache map[string]bool
}

func NewManager(ssh websiteSSH) *Manager {
	return &Manager{ssh: ssh, rootCache: make(map[string]bool)}
}

var siteNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

func (m *Manager) Status(sessionID string) (types.WebsiteStatus, error) {
	// Status deliberately runs unprivileged: listing sites is a read, and asking
	// for sudo just to populate a panel would train the user to approve it. The
	// consequence is that a non-root session may be able to list
	// /etc/nginx/sites-available but not read the files in it, which used to
	// surface as "backend detected, zero sites" with no hint that permission was
	// the reason. UNREADABLE lets the UI tell those two states apart.
	const script = `
enc() { printf '%s' "$1" | base64 | tr -d '\n'; }
emit_site() {
  backend=$1; mode=$2; enabled=$3; name=$4; file=$5
  # -r rather than an empty-output check: a genuinely empty config file is
  # readable and should be reported as a site with no content, not as an error.
  if [ ! -r "$file" ] || ! content=$(base64 < "$file" 2>/dev/null | tr -d '\n'); then
    printf 'UNREADABLE\t%s\t%s\n' "$backend" "$(enc "$name")"
    return
  fi
  printf 'SITE\t%s\t%s\t%s\t%s\t%s\n' "$backend" "$mode" "$enabled" "$(enc "$name")" "$content"
}
if command -v nginx >/dev/null 2>&1; then
  if [ -d /etc/nginx/sites-available ]; then
    printf 'BACKEND\tnginx\tsites\n'
    count=0
    for file in /etc/nginx/sites-available/*; do
      [ -f "$file" ] || continue
      name=${file##*/}; enabled=0
      [ -e "/etc/nginx/sites-enabled/$name" ] && enabled=1
      emit_site nginx sites "$enabled" "$name" "$file"
      count=$((count+1)); [ "$count" -ge 256 ] && break
    done
  else
    printf 'BACKEND\tnginx\tconfd\n'
    count=0
    for file in /etc/nginx/conf.d/*.conf /etc/nginx/conf.d/*.conf.disabled; do
      [ -f "$file" ] || continue
      name=${file##*/}; enabled=1
      case "$name" in *.disabled) name=${name%.disabled}; enabled=0;; esac
      emit_site nginx confd "$enabled" "$name" "$file"
      count=$((count+1)); [ "$count" -ge 256 ] && break
    done
  fi
fi
if command -v apache2ctl >/dev/null 2>&1 && [ -d /etc/apache2/sites-available ]; then
  printf 'BACKEND\tapache\tsites\n'
  count=0
  for file in /etc/apache2/sites-available/*; do
    [ -f "$file" ] || continue
    name=${file##*/}; enabled=0
    [ -e "/etc/apache2/sites-enabled/$name" ] && enabled=1
    emit_site apache sites "$enabled" "$name" "$file"
    count=$((count+1)); [ "$count" -ge 256 ] && break
  done
fi`
	out, err := m.ssh.Exec(sessionID, script, 30*time.Second)
	if err != nil && strings.TrimSpace(out) == "" {
		return types.WebsiteStatus{}, err
	}
	status, parseErr := parseStatus(out)
	if parseErr != nil {
		return types.WebsiteStatus{}, parseErr
	}
	return status, nil
}

func (m *Manager) Config(sessionID, backend, mode, name string) (string, error) {
	path, err := sitePath(backend, mode, name)
	if err != nil {
		return "", err
	}
	if mode == "confd" {
		path = fmt.Sprintf(`if [ -f %s ]; then file=%s; elif [ -f %s ]; then file=%s; else exit 44; fi`, shellQuote(path), shellQuote(path), shellQuote(path+".disabled"), shellQuote(path+".disabled"))
	} else {
		path = "file=" + shellQuote(path)
	}
	cmd := path + `; [ -f "$file" ] || exit 44; base64 < "$file" | tr -d '\n'`
	out, execErr := m.ssh.Exec(sessionID, cmd, 20*time.Second)
	if execErr != nil {
		return "", fmt.Errorf("读取站点配置失败: %w", execErr)
	}
	decoded, decodeErr := base64.StdEncoding.DecodeString(strings.TrimSpace(out))
	if decodeErr != nil {
		return "", fmt.Errorf("站点配置返回了无效数据")
	}
	if len(decoded) > 2*1024*1024 {
		return "", fmt.Errorf("站点配置超过 2 MiB，拒绝在面板中编辑")
	}
	return string(decoded), nil
}

func (m *Manager) Save(sessionID, backend, mode, name, config string) error {
	path, err := sitePath(backend, mode, name)
	if err != nil {
		return err
	}
	if config == "" || len(config) > 2*1024*1024 || strings.IndexByte(config, 0) >= 0 {
		return fmt.Errorf("站点配置不能为空且不能超过 2 MiB")
	}
	payload := base64.StdEncoding.EncodeToString([]byte(config))
	resolve := "dest=" + shellQuote(path)
	enabledCheck := "enabled=0"
	if backend == "nginx" && mode == "sites" {
		enabledCheck = fmt.Sprintf(`[ -e %s ] && enabled=1 || enabled=0`, shellQuote("/etc/nginx/sites-enabled/"+name))
	} else if backend == "apache" {
		enabledCheck = fmt.Sprintf(`[ -e %s ] && enabled=1 || enabled=0`, shellQuote("/etc/apache2/sites-enabled/"+name))
	} else if mode == "confd" {
		resolve = fmt.Sprintf(`dest=%s; if [ -f %s ] && [ ! -f "$dest" ]; then dest=%s; fi`, shellQuote(path), shellQuote(path+".disabled"), shellQuote(path+".disabled"))
		enabledCheck = `case "$dest" in *.disabled) enabled=0;; *) enabled=1;; esac`
	}
	testCmd, reloadCmd := backendCommands(backend)
	script := fmt.Sprintf(`set -eu
%s
%s
tmp=$(mktemp); backup=$(mktemp); existed=0
trap 'rm -f "$tmp" "$backup"' EXIT
printf '%%s' %s | base64 -d > "$tmp"
if [ -f "$dest" ]; then cp -p "$dest" "$backup"; existed=1; fi
install -m 0644 "$tmp" "$dest"
if [ "$enabled" = 1 ]; then
  if ! output=$(%s 2>&1); then
    if [ "$existed" = 1 ]; then cp -p "$backup" "$dest"; else rm -f "$dest"; fi
    printf '%%s\n' "$output"; exit 1
  fi
  %s
fi`, resolve, enabledCheck, shellQuote(payload), testCmd, reloadCmd)
	return m.execRoot(sessionID, script, 45*time.Second, "保存站点配置失败")
}

func (m *Manager) SetEnabled(sessionID, backend, mode, name string, enabled bool) error {
	path, err := sitePath(backend, mode, name)
	if err != nil {
		return err
	}
	testCmd, reloadCmd := backendCommands(backend)
	var change, rollback string
	switch {
	case backend == "nginx" && mode == "sites":
		link := "/etc/nginx/sites-enabled/" + name
		if enabled {
			change = fmt.Sprintf("ln -sfn %s %s", shellQuote(path), shellQuote(link))
			rollback = "rm -f " + shellQuote(link)
		} else {
			change = "rm -f " + shellQuote(link)
			rollback = fmt.Sprintf("ln -sfn %s %s", shellQuote(path), shellQuote(link))
		}
	case backend == "nginx" && mode == "confd":
		disabledPath := path + ".disabled"
		if enabled {
			change = fmt.Sprintf("mv %s %s", shellQuote(disabledPath), shellQuote(path))
			rollback = fmt.Sprintf("mv %s %s", shellQuote(path), shellQuote(disabledPath))
		} else {
			change = fmt.Sprintf("mv %s %s", shellQuote(path), shellQuote(disabledPath))
			rollback = fmt.Sprintf("mv %s %s", shellQuote(disabledPath), shellQuote(path))
		}
	case backend == "apache":
		if enabled {
			change = "a2ensite " + shellQuote(name) + " >/dev/null"
			rollback = "a2dissite " + shellQuote(name) + " >/dev/null"
		} else {
			change = "a2dissite " + shellQuote(name) + " >/dev/null"
			rollback = "a2ensite " + shellQuote(name) + " >/dev/null"
		}
	default:
		return fmt.Errorf("不支持的站点后端")
	}
	script := fmt.Sprintf(`set -eu
%s
if ! output=$(%s 2>&1); then %s; printf '%%s\n' "$output"; exit 1; fi
%s`, change, testCmd, rollback, reloadCmd)
	return m.execRoot(sessionID, script, 45*time.Second, "切换站点状态失败")
}

func (m *Manager) Delete(sessionID, backend, mode, name string) error {
	path, err := sitePath(backend, mode, name)
	if err != nil {
		return err
	}
	testCmd, reloadCmd := backendCommands(backend)
	var paths []string
	switch {
	case backend == "nginx" && mode == "sites":
		paths = []string{path, "/etc/nginx/sites-enabled/" + name}
	case backend == "nginx" && mode == "confd":
		paths = []string{path, path + ".disabled"}
	case backend == "apache":
		paths = []string{path, "/etc/apache2/sites-enabled/" + name}
	default:
		return fmt.Errorf("不支持的站点后端")
	}
	// The configuration is copied before removal so a failed global config test
	// can restore it. Symlinks are reconstructed from the known safe target.
	backupRestore := ""
	remove := ""
	for i, item := range paths {
		remove += "rm -f " + shellQuote(item) + "\n"
		if i == 0 {
			backupRestore = fmt.Sprintf(`backup=$(mktemp); existed=0; actual=%s
if [ ! -f "$actual" ] && [ -f %s ]; then actual=%s; fi
if [ -f "$actual" ]; then cp -p "$actual" "$backup"; existed=1; fi`, shellQuote(path), shellQuote(path+".disabled"), shellQuote(path+".disabled"))
		}
	}
	restore := `[ "$existed" = 1 ] && cp -p "$backup" "$actual" || true`
	if backend == "nginx" && mode == "sites" {
		link := "/etc/nginx/sites-enabled/" + name
		backupRestore += fmt.Sprintf("\nwas_enabled=0; [ -e %s ] && was_enabled=1 || true", shellQuote(link))
		restore += fmt.Sprintf(`; [ "$was_enabled" = 1 ] && ln -sfn %s %s || true`, shellQuote(path), shellQuote(link))
	} else if backend == "apache" {
		link := "/etc/apache2/sites-enabled/" + name
		backupRestore += fmt.Sprintf("\nwas_enabled=0; [ -e %s ] && was_enabled=1 || true", shellQuote(link))
		restore += `; [ "$was_enabled" = 1 ] && a2ensite ` + shellQuote(name) + " >/dev/null 2>&1 || true"
	}
	script := fmt.Sprintf(`set -eu
%s
trap 'rm -f "$backup"' EXIT
%s
if ! output=$(%s 2>&1); then %s; printf '%%s\n' "$output"; exit 1; fi
%s`, backupRestore, remove, testCmd, restore, reloadCmd)
	return m.execRoot(sessionID, script, 45*time.Second, "删除站点失败")
}

func (m *Manager) Test(sessionID, backend string) (string, error) {
	testCmd, _ := backendCommands(backend)
	if testCmd == "" {
		return "", fmt.Errorf("不支持的站点后端")
	}
	prefix := m.sudoPrefix(sessionID)
	out, err := m.ssh.Exec(sessionID, prefix+testCmd+" 2>&1", 30*time.Second)
	if err != nil {
		return out, fmt.Errorf("配置检查失败: %v: %s", err, strings.TrimSpace(out))
	}
	return out, nil
}

func parseStatus(out string) (types.WebsiteStatus, error) {
	status := types.WebsiteStatus{Backends: []string{}, Sites: []types.WebsiteInfo{}}
	backendSeen := make(map[string]bool)
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) >= 3 && fields[0] == "BACKEND" {
			key := fields[1] + ":" + fields[2]
			if !backendSeen[key] {
				backendSeen[key] = true
				status.Backends = append(status.Backends, key)
			}
			continue
		}
		// A site whose config could not be read is counted but not listed: the
		// panel cannot show or edit something it never received, and the count is
		// what lets it explain why the list looks short.
		if len(fields) == 3 && fields[0] == "UNREADABLE" {
			status.Unreadable++
			continue
		}
		if len(fields) != 6 || fields[0] != "SITE" {
			continue
		}
		nameBytes, nameErr := base64.StdEncoding.DecodeString(fields[4])
		configBytes, configErr := base64.StdEncoding.DecodeString(fields[5])
		if nameErr != nil || configErr != nil || len(configBytes) > 2*1024*1024 {
			return types.WebsiteStatus{}, fmt.Errorf("站点列表包含无效数据")
		}
		site := parseWebsiteConfig(fields[1], fields[2], string(nameBytes), fields[3] == "1", string(configBytes))
		status.Sites = append(status.Sites, site)
	}
	sort.Slice(status.Sites, func(i, j int) bool {
		if status.Sites[i].Enabled != status.Sites[j].Enabled {
			return status.Sites[i].Enabled
		}
		return strings.ToLower(status.Sites[i].Name) < strings.ToLower(status.Sites[j].Name)
	})
	return status, nil
}

var (
	nginxServerNameRe = regexp.MustCompile(`(?m)^\s*server_name\s+([^;]+);`)
	nginxListenRe     = regexp.MustCompile(`(?m)^\s*listen\s+([^;]+);`)
	nginxRootRe       = regexp.MustCompile(`(?m)^\s*root\s+([^;]+);`)
	apacheNameRe      = regexp.MustCompile(`(?mi)^\s*Server(?:Name|Alias)\s+(.+)$`)
	apacheListenRe    = regexp.MustCompile(`(?mi)<VirtualHost\s+([^>]+)>`)
	apacheRootRe      = regexp.MustCompile(`(?mi)^\s*DocumentRoot\s+(.+)$`)
)

func parseWebsiteConfig(backend, mode, name string, enabled bool, config string) types.WebsiteInfo {
	site := types.WebsiteInfo{Backend: backend, Mode: mode, Name: name, Enabled: enabled, ServerNames: []string{}, Listen: []string{}}
	if backend == "nginx" {
		for _, match := range nginxServerNameRe.FindAllStringSubmatch(config, -1) {
			site.ServerNames = append(site.ServerNames, strings.Fields(match[1])...)
		}
		for _, match := range nginxListenRe.FindAllStringSubmatch(config, -1) {
			site.Listen = append(site.Listen, strings.TrimSpace(match[1]))
		}
		if match := nginxRootRe.FindStringSubmatch(config); len(match) == 2 {
			site.Root = strings.Trim(strings.TrimSpace(match[1]), `"'`)
		}
	} else {
		for _, match := range apacheNameRe.FindAllStringSubmatch(config, -1) {
			site.ServerNames = append(site.ServerNames, strings.Fields(strings.TrimSpace(match[1]))...)
		}
		for _, match := range apacheListenRe.FindAllStringSubmatch(config, -1) {
			site.Listen = append(site.Listen, strings.TrimSpace(match[1]))
		}
		if match := apacheRootRe.FindStringSubmatch(config); len(match) == 2 {
			site.Root = strings.Trim(strings.TrimSpace(match[1]), `"'`)
		}
	}
	return site
}

func sitePath(backend, mode, name string) (string, error) {
	if !siteNameRe.MatchString(name) || strings.Contains(name, "..") {
		return "", fmt.Errorf("无效的站点配置名称")
	}
	switch {
	case backend == "nginx" && mode == "sites":
		return "/etc/nginx/sites-available/" + name, nil
	case backend == "nginx" && mode == "confd":
		if !strings.HasSuffix(name, ".conf") {
			name += ".conf"
		}
		return "/etc/nginx/conf.d/" + name, nil
	case backend == "apache" && mode == "sites":
		if !strings.HasSuffix(name, ".conf") {
			name += ".conf"
		}
		return "/etc/apache2/sites-available/" + name, nil
	default:
		return "", fmt.Errorf("不支持的站点后端")
	}
}

func backendCommands(backend string) (string, string) {
	switch backend {
	case "nginx":
		return "nginx -t", "systemctl reload nginx 2>/dev/null || nginx -s reload"
	case "apache":
		return "apache2ctl configtest", "systemctl reload apache2 2>/dev/null || apache2ctl graceful"
	default:
		return "", ""
	}
}

func shellQuote(value string) string { return "'" + strings.ReplaceAll(value, "'", `'"'"'`) + "'" }

func (m *Manager) sudoPrefix(sessionID string) string {
	m.rootMu.Lock()
	isRoot, ok := m.rootCache[sessionID]
	m.rootMu.Unlock()
	if !ok {
		out, err := m.ssh.Exec(sessionID, "id -u", 10*time.Second)
		isRoot = err == nil && strings.TrimSpace(out) == "0"
		m.rootMu.Lock()
		if len(m.rootCache) >= 64 {
			m.rootCache = make(map[string]bool)
		}
		m.rootCache[sessionID] = isRoot
		m.rootMu.Unlock()
	}
	if isRoot {
		return ""
	}
	return "sudo -n "
}

func (m *Manager) execRoot(sessionID, script string, timeout time.Duration, prefix string) error {
	sudo := m.sudoPrefix(sessionID)
	out, err := m.ssh.Exec(sessionID, sudo+"sh -c "+shellQuote(script), timeout)
	if err != nil {
		combined := strings.ToLower(out + " " + err.Error())
		if sudo != "" && (strings.Contains(combined, "sudo:") || strings.Contains(combined, "password is required")) {
			return fmt.Errorf("该操作需要 root 或免密 sudo")
		}
		if strings.TrimSpace(out) != "" {
			return fmt.Errorf("%s: %v: %s", prefix, err, strings.TrimSpace(out))
		}
		return fmt.Errorf("%s: %w", prefix, err)
	}
	return nil
}
