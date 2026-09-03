package monitor

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"gxShell/backend/types"
)

type Executor interface {
	Exec(sessionID string, command string, timeout time.Duration) (string, error)
}

type Manager struct {
	exec    Executor
	emit    func(event string, data any)
	mu      sync.RWMutex
	running map[string]*poller
	latest  map[string]types.Metrics
	lastCPU map[string]cpuSample
	lastNet map[string]netSample
}

// poller identifies one concrete monitoring loop. Keeping the interval and a
// stable identity together lets Start/RestartAll replace a running loop
// without allowing a slow result from the old loop to overwrite fresh data.
type poller struct {
	stop        chan struct{}
	intervalSec int
}

type cpuSample struct {
	idle  uint64
	total uint64
}

type netSample struct {
	rx uint64
	tx uint64
	at time.Time
}

func NewManager(exec Executor, emit func(event string, data any)) *Manager {
	return &Manager{
		exec:    exec,
		emit:    emit,
		running: map[string]*poller{},
		latest:  map[string]types.Metrics{},
		lastCPU: map[string]cpuSample{},
		lastNet: map[string]netSample{},
	}
}

func (m *Manager) Start(sessionID string, intervalSec int) {
	if sessionID == "" {
		return
	}
	if intervalSec <= 0 {
		intervalSec = 5
	}
	m.mu.Lock()
	if current := m.running[sessionID]; current != nil && current.intervalSec == intervalSec {
		m.mu.Unlock()
		return
	}
	if current := m.running[sessionID]; current != nil {
		close(current.stop)
	}
	run := &poller{stop: make(chan struct{}), intervalSec: intervalSec}
	m.running[sessionID] = run
	m.mu.Unlock()
	m.startPoller(sessionID, run)
}

func (m *Manager) startPoller(sessionID string, run *poller) {
	go func() {
		ticker := time.NewTicker(time.Duration(run.intervalSec) * time.Second)
		defer ticker.Stop()
		m.collectAndEmit(sessionID, run)
		for {
			select {
			case <-ticker.C:
				m.collectAndEmit(sessionID, run)
			case <-run.stop:
				return
			}
		}
	}()
}

func (m *Manager) Stop(sessionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if run := m.running[sessionID]; run != nil {
		close(run.stop)
		delete(m.running, sessionID)
	}
	// Session IDs are unique per connection, so per-session samples are dead
	// weight once the poller stops; without this the maps grow forever.
	delete(m.latest, sessionID)
	delete(m.lastCPU, sessionID)
	delete(m.lastNet, sessionID)
}

// StopAll stops every active poller. It is used when monitoring is disabled in
// settings, so a renderer reconnect event cannot leave background collectors
// running against the user's explicit preference.
func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for sessionID, run := range m.running {
		close(run.stop)
		delete(m.running, sessionID)
	}
	clear(m.latest)
	clear(m.lastCPU)
	clear(m.lastNet)
}

// RestartAll applies a new interval to active sessions. Sessions already using
// the requested interval are left alone; replaced pollers collect immediately
// at the new cadence.
func (m *Manager) RestartAll(intervalSec int) {
	if intervalSec <= 0 {
		intervalSec = 5
	}
	type restart struct {
		sessionID string
		run       *poller
	}
	restarts := make([]restart, 0)
	m.mu.Lock()
	for sessionID, current := range m.running {
		if current.intervalSec == intervalSec {
			continue
		}
		close(current.stop)
		run := &poller{stop: make(chan struct{}), intervalSec: intervalSec}
		m.running[sessionID] = run
		restarts = append(restarts, restart{sessionID: sessionID, run: run})
	}
	m.mu.Unlock()
	for _, item := range restarts {
		m.startPoller(item.sessionID, item.run)
	}
}

func (m *Manager) Latest(sessionID string) types.Metrics {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.latest[sessionID]
}

func (m *Manager) collectAndEmit(sessionID string, run *poller) {
	m.mu.RLock()
	current := m.running[sessionID]
	m.mu.RUnlock()
	if current != run {
		return
	}
	start := time.Now()
	script := `gx_section() { printf 'GX_BEGIN_%s_9b7c2d\n' "$1"; sh -c "$2"; printf 'GX_END_%s_9b7c2d\n' "$1"; }
	gx_section OS 'LC_ALL=C cat /etc/os-release 2>/dev/null || LC_ALL=C uname -s 2>/dev/null'
	gx_section UPTIME 'LC_ALL=C uptime -p 2>/dev/null || LC_ALL=C uptime 2>/dev/null'
	gx_section LOAD 'LC_ALL=C cat /proc/loadavg 2>/dev/null'
	gx_section MEM 'LC_ALL=C cat /proc/meminfo 2>/dev/null'
	gx_section DISK 'LC_ALL=C df -kP / 2>/dev/null | tail -n 1'
	gx_section CPU 'LC_ALL=C head -n 1 /proc/stat 2>/dev/null'
	gx_section DEFAULT_IFACE "LC_ALL=C ip route get 1.1.1.1 2>/dev/null | awk '\''{for(i=1;i<=NF;i++) if(\$i==\"dev\") {print \$(i+1); exit}}'\''"
	gx_section NET 'LC_ALL=C cat /proc/net/dev 2>/dev/null'
	gx_section PROC 'LC_ALL=C ps aux --sort=-%mem 2>/dev/null | head -n 6 || LC_ALL=C ps -eo user,pid,%cpu,%mem,vsz,rss,tty,stat,start,time,args --sort=-%mem 2>/dev/null | head -n 6'`
	out, err := m.exec.Exec(sessionID, script, 5*time.Second)
	metrics := parseMetrics(sessionID, out)
	metrics.Online = err == nil
	metrics.LatencyMs = time.Since(start).Milliseconds()
	metrics.UpdatedAt = time.Now()
	if err != nil {
		metrics.Error = err.Error()
	}

	m.mu.Lock()
	// A settings update may have replaced this poller while Exec was in flight.
	// Discard that stale sample rather than publishing it under the new cadence.
	if m.running[sessionID] != run {
		m.mu.Unlock()
		return
	}
	if cpu, ok := parseCPU(section(out, "CPU")); ok {
		// Skip the delta when counters went backwards (remote reboot resets
		// /proc/stat); a uint64 underflow would produce one frame of garbage.
		if prev, exists := m.lastCPU[sessionID]; exists && cpu.total >= prev.total && cpu.idle >= prev.idle {
			totalDelta := cpu.total - prev.total
			idleDelta := cpu.idle - prev.idle
			if totalDelta > 0 {
				metrics.CPUPercent = float64(totalDelta-idleDelta) / float64(totalDelta) * 100
			}
		}
		m.lastCPU[sessionID] = cpu
	}
	if netNow, ok := parseNet(section(out, "NET"), strings.TrimSpace(section(out, "DEFAULT_IFACE"))); ok {
		if prev, exists := m.lastNet[sessionID]; exists && netNow.rx >= prev.rx && netNow.tx >= prev.tx {
			seconds := netNow.at.Sub(prev.at).Seconds()
			if seconds > 0 {
				metrics.NetworkRxPerSec = int64(float64(netNow.rx-prev.rx) / seconds)
				metrics.NetworkTxPerSec = int64(float64(netNow.tx-prev.tx) / seconds)
			}
		}
		m.lastNet[sessionID] = netNow
	}
	m.latest[sessionID] = metrics
	m.mu.Unlock()
	if m.emit != nil {
		m.emit("monitor:update", metrics)
	}
}

func parseOS(text string) string {
	lower := strings.ToLower(text)
	if strings.Contains(lower, "ubuntu") {
		return "ubuntu"
	}
	if strings.Contains(lower, "debian") {
		return "debian"
	}
	if strings.Contains(lower, "rocky") || strings.Contains(lower, "alma") {
		return "rocky"
	}
	if strings.Contains(lower, "centos") {
		return "centos"
	}
	if strings.Contains(lower, "alpine") {
		return "alpine"
	}
	if strings.Contains(lower, "arch") {
		return "arch"
	}
	if strings.Contains(lower, "fedora") || strings.Contains(lower, "red hat") || strings.Contains(lower, "rhel") {
		return "redhat"
	}
	if strings.Contains(lower, "darwin") {
		return "macos"
	}
	if strings.Contains(lower, "freebsd") {
		return "freebsd"
	}
	if strings.Contains(lower, "linux") {
		return "linux"
	}
	return ""
}

func parseMetrics(sessionID, out string) types.Metrics {
	metrics := types.Metrics{SessionID: sessionID}
	metrics.OS = parseOS(section(out, "OS"))
	metrics.Uptime = strings.TrimSpace(section(out, "UPTIME"))
	load := strings.Fields(section(out, "LOAD"))
	if len(load) >= 3 {
		metrics.LoadAverage = strings.Join(load[:3], " ")
	}
	parseMem(section(out, "MEM"), &metrics)
	parseDisk(section(out, "DISK"), &metrics)
	metrics.TopProcesses = parseProcesses(section(out, "PROC"))
	return metrics
}

func section(out, name string) string {
	begin := "GX_BEGIN_" + name + "_9b7c2d"
	end := "GX_END_" + name + "_9b7c2d"
	start := strings.Index(out, begin)
	if start < 0 {
		return ""
	}
	start += len(begin)
	rest := out[start:]
	stop := strings.Index(rest, end)
	if stop < 0 {
		return strings.TrimSpace(rest)
	}
	return strings.TrimSpace(rest[:stop])
}

func parseMem(text string, metrics *types.Metrics) {
	values := map[string]int64{}
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(strings.ReplaceAll(line, ":", ""))
		if len(fields) >= 2 {
			v, _ := strconv.ParseInt(fields[1], 10, 64)
			values[fields[0]] = v / 1024
		}
	}
	total := values["MemTotal"]
	available := values["MemAvailable"]
	if total > 0 {
		used := total - available
		metrics.MemoryTotalMB = total
		metrics.MemoryUsedMB = used
		metrics.MemoryPercent = float64(used) / float64(total) * 100
	}
	swapTotal := values["SwapTotal"]
	swapFree := values["SwapFree"]
	if swapTotal > 0 {
		metrics.SwapTotalMB = swapTotal
		metrics.SwapUsedMB = swapTotal - swapFree
	}
}

func parseDisk(text string, metrics *types.Metrics) {
	fields := strings.Fields(text)
	if len(fields) < 5 {
		return
	}
	used, _ := strconv.ParseFloat(fields[2], 64)
	total, _ := strconv.ParseFloat(fields[1], 64)
	metrics.DiskUsed = humanKB(fields[2])
	metrics.DiskTotal = humanKB(fields[1])
	if total > 0 {
		metrics.DiskPercent = used / total * 100
	}
}

func humanKB(s string) string {
	kb, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return s
	}
	gb := kb / 1024 / 1024
	if gb >= 1 {
		return fmt.Sprintf("%.1f GB", gb)
	}
	return fmt.Sprintf("%.0f MB", kb/1024)
}

func parseCPU(text string) (cpuSample, bool) {
	fields := strings.Fields(text)
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuSample{}, false
	}
	var nums []uint64
	for _, field := range fields[1:] {
		v, _ := strconv.ParseUint(field, 10, 64)
		nums = append(nums, v)
	}
	var total uint64
	for _, v := range nums {
		total += v
	}
	return cpuSample{idle: nums[3], total: total}, true
}

func parseNet(text string, defaultIface string) (netSample, bool) {
	var rx, tx uint64
	for _, line := range strings.Split(text, "\n") {
		if !strings.Contains(line, ":") {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		iface := strings.TrimSpace(parts[0])
		if defaultIface != "" && iface != defaultIface {
			continue
		}
		if shouldIgnoreInterface(iface) {
			continue
		}
		fields := strings.Fields(parts[1])
		if len(fields) < 16 {
			continue
		}
		r, _ := strconv.ParseUint(fields[0], 10, 64)
		t, _ := strconv.ParseUint(fields[8], 10, 64)
		rx += r
		tx += t
	}
	return netSample{rx: rx, tx: tx, at: time.Now()}, rx > 0 || tx > 0
}

func shouldIgnoreInterface(iface string) bool {
	if iface == "lo" {
		return true
	}
	prefixes := []string{"docker", "br-", "veth", "tun", "tap", "wg", "virbr", "zt", "tailscale"}
	for _, prefix := range prefixes {
		if strings.HasPrefix(iface, prefix) {
			return true
		}
	}
	return false
}

func parseProcesses(text string) []types.ProcessInfo {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) <= 1 {
		return []types.ProcessInfo{}
	}
	items := []types.ProcessInfo{}
	for _, line := range lines[1:] {
		fields := strings.Fields(line)
		if len(fields) < 11 {
			continue
		}
		cpu, _ := strconv.ParseFloat(fields[2], 64)
		mem, _ := strconv.ParseFloat(fields[3], 64)
		items = append(items, types.ProcessInfo{
			User:    fields[0],
			PID:     fields[1],
			CPU:     cpu,
			Memory:  mem,
			Command: strings.Join(fields[10:], " "),
		})
	}
	return items
}
