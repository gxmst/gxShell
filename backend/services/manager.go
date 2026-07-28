package services

import (
	"bufio"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	sshmanager "gxShell/backend/ssh"
	"gxShell/backend/types"
)

type Manager struct {
	ssh        *sshmanager.Manager
	emit       func(event string, data any)
	mu         sync.Mutex
	logStreams map[string]*logStream
	logByKey   map[string]string
	rootMu     sync.Mutex
	rootCache  map[string]bool
}

// logStream identifies a single journal-follow goroutine. The pointer doubles
// as the identity token: a teardown only removes the map entry if it still
// points at itself, so a superseded stream can't delete the entry of the one
// that replaced it.
type logStream struct {
	id        string
	key       string
	sessionID string
	unit      string
	cancel    func()
	once      sync.Once
}

func NewManager(sshMgr *sshmanager.Manager) *Manager {
	return &Manager{
		ssh:        sshMgr,
		emit:       func(event string, data any) {},
		logStreams: make(map[string]*logStream),
		logByKey:   make(map[string]string),
		rootCache:  make(map[string]bool),
	}
}

func (m *Manager) SetEmit(fn func(event string, data any)) {
	if fn != nil {
		m.emit = fn
	}
}

// unitNameRe covers regular units (nginx.service), template instances
// (getty@tty1.service) and device-style names; anything with shell
// metacharacters is rejected because unit names are interpolated into
// remote commands.
var unitNameRe = regexp.MustCompile(`^[A-Za-z0-9@:._\-]+$`)

func sanitizeUnit(unit string) error {
	if unit == "" || len(unit) > 256 || !unitNameRe.MatchString(unit) {
		return fmt.Errorf("invalid unit name")
	}
	return nil
}

var safeIDRe = regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`)

func sanitizeLogStreamID(streamID string) error {
	if len(streamID) > 128 || !safeIDRe.MatchString(streamID) {
		return fmt.Errorf("invalid log stream id")
	}
	return nil
}

// clampLogLines bounds a journalctl -n argument: default 300, hard cap 100000.
func clampLogLines(lines int) int {
	if lines <= 0 {
		return 300
	}
	if lines > 100000 {
		return 100000
	}
	return lines
}

// criticalUnits are services whose stop/disable can sever remote access or
// networking on the very host being managed.
var criticalUnits = map[string]bool{
	"ssh":              true,
	"sshd":             true,
	"systemd-networkd": true,
	"NetworkManager":   true,
	"networking":       true,
}

func isCriticalUnit(unit string) bool {
	return criticalUnits[strings.TrimSuffix(unit, ".service")]
}

func (m *Manager) ListServices(sessionID string) ([]types.ServiceInfo, error) {
	out, err := m.ssh.Exec(sessionID, "systemctl list-units --type=service --all --plain --no-legend --no-pager", 20*time.Second)
	if err != nil {
		if isCommandNotFound(out, err) {
			return nil, fmt.Errorf("systemd not detected on this host")
		}
		return nil, err
	}
	services := parseListUnits(out)
	// Enabled state is a best-effort merge: a host where list-unit-files fails
	// still gets its unit list, just with Enabled left empty.
	if filesOut, err := m.ssh.Exec(sessionID, "systemctl list-unit-files --type=service --plain --no-legend --no-pager", 20*time.Second); err == nil {
		mergeEnabled(services, parseUnitFiles(filesOut))
	}
	// procps exposes the owning systemd unit for every process. Aggregating one
	// snapshot is much cheaper than running systemctl show once per service and
	// gives the UI meaningful current CPU/RSS values. BusyBox/minimal hosts may
	// not support the unit column; resource data is intentionally best-effort.
	//
	// ResourceStats marks the units this snapshot actually accounted for. Without
	// it a host whose ps has no unit column is indistinguishable from one where
	// every service genuinely uses no CPU, and the panel would confidently show
	// "CPU 0.0% · 0 MB" for everything.
	if usageOut, err := m.ssh.Exec(sessionID, "LC_ALL=C ps -eo unit=,pcpu=,rss= --no-headers", 20*time.Second); err == nil {
		mergeResourceUsage(services, parseResourceUsage(usageOut))
	}
	return services, nil
}

type serviceResourceUsage struct {
	cpuPercent  float64
	memoryBytes int64
}

func parseResourceUsage(out string) map[string]serviceResourceUsage {
	usage := make(map[string]serviceResourceUsage)
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 3 || fields[0] == "-" || fields[0] == "init.scope" {
			continue
		}
		cpu, errCPU := strconv.ParseFloat(fields[1], 64)
		rssKB, errRSS := strconv.ParseInt(fields[2], 10, 64)
		if errCPU != nil || errRSS != nil || rssKB < 0 {
			continue
		}
		current := usage[fields[0]]
		current.cpuPercent += cpu
		current.memoryBytes += rssKB * 1024
		usage[fields[0]] = current
	}
	return usage
}

// mergeResourceUsage attaches one ps snapshot to the unit list.
//
// An empty snapshot means ps produced nothing usable (no unit column on this
// host, or output this parser did not recognise), so no unit gets stats and the
// UI shows them as unmeasured. A non-empty snapshot that simply lacks a given
// unit is different: that unit is accounted for and has no running processes, so
// zero is a real measurement.
func mergeResourceUsage(services []types.ServiceInfo, usage map[string]serviceResourceUsage) {
	if len(usage) == 0 {
		return
	}
	for i := range services {
		services[i].ResourceStats = true
		if current, ok := usage[services[i].Name]; ok {
			services[i].CPUPercent = current.cpuPercent
			services[i].MemoryBytes = current.memoryBytes
		}
	}
}

func isCommandNotFound(out string, err error) bool {
	combined := out + " " + err.Error()
	return strings.Contains(combined, "not found") || strings.Contains(combined, "exited with status 127")
}

// parseListUnits parses `systemctl list-units --plain --no-legend` output:
// UNIT LOAD ACTIVE SUB DESCRIPTION..., where the description is the remainder
// and may contain spaces. Older systemd versions prefix failed/not-found units
// with a "●"/"x"/"*" marker column even in --plain mode; it is stripped.
func parseListUnits(out string) []types.ServiceInfo {
	var services []types.ServiceInfo
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) > 0 && (fields[0] == "●" || fields[0] == "x" || fields[0] == "*") {
			fields = fields[1:]
		}
		if len(fields) < 4 {
			continue
		}
		services = append(services, types.ServiceInfo{
			Name:        fields[0],
			LoadState:   fields[1],
			ActiveState: fields[2],
			SubState:    fields[3],
			Description: strings.Join(fields[4:], " "),
		})
	}
	return services
}

// parseUnitFiles parses `systemctl list-unit-files --plain --no-legend` output
// (UNIT STATE [PRESET]) into unit -> enablement state.
func parseUnitFiles(out string) map[string]string {
	states := make(map[string]string)
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		states[fields[0]] = fields[1]
	}
	return states
}

// mergeEnabled fills ServiceInfo.Enabled from the unit-file states. Template
// instances (getty@tty1.service) fall back to their template's unit file
// (getty@.service), which is what carries the enablement state.
func mergeEnabled(services []types.ServiceInfo, states map[string]string) {
	for i := range services {
		name := services[i].Name
		if state, ok := states[name]; ok {
			services[i].Enabled = state
			continue
		}
		if at := strings.Index(name, "@"); at >= 0 {
			if dot := strings.LastIndex(name, "."); dot > at {
				if state, ok := states[name[:at+1]+name[dot:]]; ok {
					services[i].Enabled = state
				}
			}
		}
	}
}

func (m *Manager) ServiceAction(sessionID, unit, action string, force bool) error {
	_, err := m.executeServiceAction(sessionID, unit, action, force)
	return err
}

func (m *Manager) executeServiceAction(sessionID, unit, action string, force bool) (string, error) {
	if err := sanitizeUnit(unit); err != nil {
		return "", err
	}
	switch action {
	case "start", "stop", "restart", "enable", "disable":
	default:
		return "", fmt.Errorf("invalid service action: %s", action)
	}
	if (action == "stop" || action == "disable") && !force && isCriticalUnit(unit) {
		return "", fmt.Errorf("refusing to %s %s: this may cut off SSH access or networking on the remote host (use force to override)", action, unit)
	}
	out, err := m.execRoot(sessionID, fmt.Sprintf("systemctl %s %s", action, unit), 30*time.Second)
	if err != nil {
		return out, cmdError(fmt.Sprintf("systemctl %s %s failed", action, unit), err, out)
	}
	return out, nil
}

// ServiceActionVerified executes one action, then performs a bounded targeted
// readback instead of refreshing the complete service/process inventory.
func (m *Manager) ServiceActionVerified(sessionID, unit, action string, force bool) (types.ServiceActionResult, error) {
	result := types.ServiceActionResult{Unit: unit, Action: action}
	if _, err := m.executeServiceAction(sessionID, unit, action, force); err != nil {
		return result, err
	}
	if action == "start" || action == "restart" || action == "stop" {
		time.Sleep(250 * time.Millisecond)
	}
	for attempt := 0; attempt < 4; attempt++ {
		observed, err := m.readServiceActionState(sessionID, unit)
		if err != nil {
			result.Verification = "action completed but state readback failed: " + err.Error()
			return result, nil
		}
		result = observed
		result.Action = action
		if result.ActiveState != "activating" && result.ActiveState != "deactivating" && result.ActiveState != "reloading" {
			break
		}
		time.Sleep(time.Duration(attempt+1) * 250 * time.Millisecond)
	}
	result.Verified, result.Verification = verifyServiceActionResult(result)
	return result, nil
}

func (m *Manager) readServiceActionState(sessionID, unit string) (types.ServiceActionResult, error) {
	cmd := fmt.Sprintf("systemctl show %s --no-pager --property=LoadState,ActiveState,SubState,UnitFileState,Result,ExecMainStatus", unit)
	out, err := m.ssh.Exec(sessionID, cmd, 15*time.Second)
	if err != nil {
		return types.ServiceActionResult{Unit: unit}, cmdError("systemctl state readback failed", err, out)
	}
	result := types.ServiceActionResult{Unit: unit, ExecMainStatus: -1}
	for _, line := range strings.Split(out, "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch key {
		case "LoadState":
			result.LoadState = value
		case "ActiveState":
			result.ActiveState = value
		case "SubState":
			result.SubState = value
		case "UnitFileState":
			result.UnitFileState = value
		case "Result":
			result.Result = value
		case "ExecMainStatus":
			if parsed, parseErr := strconv.Atoi(value); parseErr == nil {
				result.ExecMainStatus = parsed
			}
		}
	}
	if result.LoadState == "" && result.ActiveState == "" && result.UnitFileState == "" {
		return result, fmt.Errorf("systemctl returned no recognizable state")
	}
	return result, nil
}

func verifyServiceActionResult(result types.ServiceActionResult) (bool, string) {
	state := result.ActiveState + "(" + result.SubState + ")"
	switch result.Action {
	case "enable":
		verified := result.UnitFileState == "enabled" || result.UnitFileState == "enabled-runtime" || result.UnitFileState == "linked" || result.UnitFileState == "linked-runtime"
		return verified, "unit file state is " + result.UnitFileState
	case "disable":
		verified := result.UnitFileState == "disabled"
		return verified, "unit file state is " + result.UnitFileState
	case "stop":
		verified := result.ActiveState == "inactive"
		return verified, "observed " + state
	case "start", "restart":
		if result.ActiveState == "active" {
			return true, "observed " + state
		}
		if result.ActiveState == "inactive" && (result.Result == "success" || result.Result == "") && result.ExecMainStatus == 0 {
			return true, "unit completed successfully and is now " + state
		}
		return false, "observed " + state + ", result=" + result.Result
	default:
		return false, "unknown action"
	}
}

func (m *Manager) ServiceLogs(sessionID, unit string, lines int) (string, error) {
	if err := sanitizeUnit(unit); err != nil {
		return "", err
	}
	cmd := fmt.Sprintf("journalctl -u %s -n %d --no-pager --output=short-iso 2>&1", unit, clampLogLines(lines))
	out, err := m.ssh.Exec(sessionID, cmd, 30*time.Second)
	if err != nil {
		// journalctl prints its reason (missing binary, no journal access) to
		// the combined output; hand that to the UI instead of an exit status.
		if strings.TrimSpace(out) != "" {
			return out, nil
		}
		return "", fmt.Errorf("failed to get service logs: %w", err)
	}
	return out, nil
}

func (m *Manager) StreamServiceLogs(sessionID, unit, streamID string, lines int) error {
	if err := sanitizeUnit(unit); err != nil {
		return err
	}
	if err := sanitizeLogStreamID(streamID); err != nil {
		return err
	}
	key := sessionID + ":" + unit

	client, err := m.ssh.Client(sessionID)
	if err != nil {
		return err
	}

	session, err := client.NewSession()
	if err != nil {
		return err
	}

	stdout, err := session.StdoutPipe()
	if err != nil {
		_ = session.Close()
		return err
	}

	cmd := fmt.Sprintf("journalctl -u %s -f -n %d --no-pager --output=short-iso 2>&1", unit, clampLogLines(lines))
	if err := session.Start(cmd); err != nil {
		_ = session.Close()
		return err
	}

	ctx := make(chan struct{})
	self := &logStream{id: streamID, key: key, sessionID: sessionID, unit: unit}
	self.cancel = func() { self.once.Do(func() { close(ctx); _ = session.Close() }) }
	if err := m.activateLogStream(self); err != nil {
		self.cancel()
		return err
	}

	// A dedicated reader goroutine feeds lines to the batching loop below. The
	// handoff select on ctx means an abandoned read cannot strand the reader,
	// and the deferred session.Close unblocks a read still in flight.
	type readResult struct {
		line string
		err  error
	}
	results := make(chan readResult, 16)
	go func() {
		reader := bufio.NewReader(stdout)
		for {
			line, err := readBoundedLine(reader)
			select {
			case results <- readResult{line: line, err: err}:
			case <-ctx:
				return
			}
			if err != nil {
				return
			}
		}
	}()

	go func() {
		defer func() {
			_ = session.Close()
		}()

		// Aggregate lines and flush on a timer or size threshold, mirroring the
		// docker log stream: emitting one Wails event per journal line floods
		// the IPC bridge on chatty units. The frontend appends event data
		// verbatim, so a batch with embedded newlines keeps the payload contract.
		var batch strings.Builder
		timer := time.NewTimer(logFlushInterval)
		defer timer.Stop()
		flush := func() {
			if batch.Len() == 0 {
				return
			}
			m.emitLogData(self, batch.String())
			batch.Reset()
		}
		resetTimer := func() {
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(logFlushInterval)
		}
		for {
			select {
			case <-ctx:
				return
			case res := <-results:
				batch.WriteString(res.line)
				if res.err != nil {
					// EOF or read error (e.g. the SSH session died): deliver what
					// is left, then notify the frontend the stream ended so it
					// doesn't wait forever.
					flush()
					select {
					case <-ctx:
					default:
						m.finishLogStream(self, true)
					}
					return
				}
				if batch.Len() >= maxLogBatchBytes {
					flush()
					resetTimer()
				}
			case <-timer.C:
				flush()
				timer.Reset(logFlushInterval)
			}
		}
	}()

	return nil
}

const (
	// maxLogLineBytes caps a single log line: bufio.Reader.ReadString would
	// otherwise grow without bound on a line that never ends. The remainder of
	// an oversized line is discarded.
	maxLogLineBytes = 256 * 1024
	// logFlushInterval/maxLogBatchBytes bound the service:log event rate the
	// same way docker:log bounds container output (time- and size-based flush).
	logFlushInterval = 50 * time.Millisecond
	maxLogBatchBytes = 32 * 1024
)

// readBoundedLine reads one line including its trailing newline, capped at
// maxLogLineBytes. An oversized line is truncated with a marker and the rest
// of it is drained without being buffered. The returned line may be non-empty
// even when err is non-nil (a final line without a newline before EOF).
func readBoundedLine(reader *bufio.Reader) (string, error) {
	var line strings.Builder
	for {
		chunk, err := reader.ReadSlice('\n')
		if line.Len()+len(chunk) > maxLogLineBytes {
			line.Write(chunk[:maxLogLineBytes-line.Len()])
			line.WriteString(" [line truncated]\n")
			for err == bufio.ErrBufferFull {
				_, err = reader.ReadSlice('\n')
			}
			return line.String(), err
		}
		line.Write(chunk)
		if err == bufio.ErrBufferFull {
			continue
		}
		return line.String(), err
	}
}

// activateLogStream installs one concrete follow operation. A newer stream for
// the same unit replaces and cancels the old one, while a stream ID may never
// be reused. Keeping both indexes lets StopServiceLogs target exactly the
// operation the UI started instead of accidentally stopping its successor.
func (m *Manager) activateLogStream(stream *logStream) error {
	m.mu.Lock()
	if _, exists := m.logStreams[stream.id]; exists {
		m.mu.Unlock()
		return fmt.Errorf("log stream id already active")
	}
	var previous *logStream
	if previousID := m.logByKey[stream.key]; previousID != "" {
		previous = m.logStreams[previousID]
		delete(m.logStreams, previousID)
	}
	m.logStreams[stream.id] = stream
	m.logByKey[stream.key] = stream.id
	m.mu.Unlock()
	if previous != nil {
		previous.cancel()
	}
	return nil
}

func (m *Manager) emitLogData(stream *logStream, data string) {
	m.mu.Lock()
	active := m.logStreams[stream.id] == stream
	m.mu.Unlock()
	if !active {
		return
	}
	m.emit("service:log", map[string]string{
		"streamID":  stream.id,
		"sessionID": stream.sessionID,
		"unit":      stream.unit,
		"data":      data,
	})
}

// finishLogStream removes a stream only if it is still the active instance.
// Superseded/stopped goroutines therefore cannot publish a late done event.
func (m *Manager) finishLogStream(stream *logStream, emitDone bool) bool {
	m.mu.Lock()
	if m.logStreams[stream.id] != stream {
		m.mu.Unlock()
		return false
	}
	delete(m.logStreams, stream.id)
	if m.logByKey[stream.key] == stream.id {
		delete(m.logByKey, stream.key)
	}
	m.mu.Unlock()
	if emitDone {
		m.emit("service:log", map[string]string{
			"streamID":  stream.id,
			"sessionID": stream.sessionID,
			"unit":      stream.unit,
			"done":      "true",
		})
	}
	return true
}

func (m *Manager) StopServiceLogs(streamID string) {
	m.mu.Lock()
	stream := m.logStreams[streamID]
	if stream != nil {
		delete(m.logStreams, streamID)
		if m.logByKey[stream.key] == streamID {
			delete(m.logByKey, stream.key)
		}
	}
	m.mu.Unlock()
	if stream != nil {
		stream.cancel()
	}
}
