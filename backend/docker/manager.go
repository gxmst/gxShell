package docker

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
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
}

// logStream identifies a single log-follow goroutine. The pointer doubles as the
// identity token: a teardown only removes the map entry if it still points at
// itself, so a superseded stream can't delete the entry of the one that replaced
// it.
type logStream struct {
	id          string
	key         string
	sessionID   string
	containerID string
	cancel      func()
	once        sync.Once
}

func NewManager(sshMgr *sshmanager.Manager) *Manager {
	return &Manager{
		ssh:        sshMgr,
		emit:       func(event string, data any) {},
		logStreams: make(map[string]*logStream),
		logByKey:   make(map[string]string),
	}
}

func (m *Manager) SetEmit(fn func(event string, data any)) {
	if fn != nil {
		m.emit = fn
	}
}

var safeIDRe = regexp.MustCompile(`^[a-zA-Z0-9_.-]+$`)

func sanitizeDockerArg(arg string) error {
	if !safeIDRe.MatchString(arg) {
		return fmt.Errorf("invalid docker argument: %s", arg)
	}
	return nil
}

func sanitizeTailArg(tail int) error {
	if tail < 0 || tail > 100000 {
		return fmt.Errorf("invalid tail value: %d", tail)
	}
	return nil
}

func sanitizeLogStreamID(streamID string) error {
	if len(streamID) > 128 || !safeIDRe.MatchString(streamID) {
		return fmt.Errorf("invalid log stream id")
	}
	return nil
}

func (m *Manager) ListContainers(sessionID string, all bool) ([]types.ContainerInfo, error) {
	flag := ""
	if all {
		flag = "-a"
	}
	cmd := fmt.Sprintf("docker ps %s --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.CreatedAt}}'", flag)
	out, err := m.ssh.Exec(sessionID, cmd, 15*time.Second)
	if err != nil {
		if strings.Contains(err.Error(), "docker") || strings.Contains(out, "docker") {
			return nil, fmt.Errorf("docker not available: %w", err)
		}
		return nil, err
	}

	var containers []types.ContainerInfo
	lines := strings.Split(strings.TrimSpace(out), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "|", 7)
		if len(parts) < 6 {
			continue
		}
		names := strings.Split(strings.TrimSpace(parts[1]), ",")
		for i := range names {
			names[i] = strings.TrimSpace(strings.TrimPrefix(names[i], "/"))
		}
		c := types.ContainerInfo{
			ID:     strings.TrimSpace(parts[0]),
			Names:  names,
			Image:  strings.TrimSpace(parts[2]),
			State:  strings.TrimSpace(parts[3]),
			Status: strings.TrimSpace(parts[4]),
			Ports:  strings.TrimSpace(parts[5]),
		}
		if len(parts) > 6 {
			c.Created = parseDockerTime(strings.TrimSpace(parts[6]))
		}
		containers = append(containers, c)
	}
	return containers, nil
}

func (m *Manager) ContainerLogs(sessionID, containerID string, tail int) (string, error) {
	if err := sanitizeDockerArg(containerID); err != nil {
		return "", err
	}
	if err := sanitizeTailArg(tail); err != nil {
		return "", err
	}
	cmd := fmt.Sprintf("docker logs --tail %d %s 2>&1", tail, containerID)
	out, err := m.ssh.Exec(sessionID, cmd, 30*time.Second)
	if err != nil {
		return out, fmt.Errorf("failed to get logs: %w", err)
	}
	return out, nil
}

func (m *Manager) StreamContainerLogs(sessionID, containerID, streamID string, tail int) error {
	if err := sanitizeDockerArg(containerID); err != nil {
		return err
	}
	if err := sanitizeLogStreamID(streamID); err != nil {
		return err
	}
	if err := sanitizeTailArg(tail); err != nil {
		return err
	}
	key := sessionID + ":" + containerID

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

	cmd := fmt.Sprintf("docker logs --tail %d --follow %s 2>&1", tail, containerID)
	if err := session.Start(cmd); err != nil {
		_ = session.Close()
		return err
	}

	ctx := make(chan struct{})
	self := &logStream{id: streamID, key: key, sessionID: sessionID, containerID: containerID}
	self.cancel = func() { self.once.Do(func() { close(ctx); _ = session.Close() }) }
	if err := m.activateLogStream(self); err != nil {
		self.cancel()
		return err
	}

	go func() {
		defer func() {
			_ = session.Close()
		}()

		reader := bufio.NewReader(stdout)
		for {
			select {
			case <-ctx:
				return
			default:
			}

			line, err := reader.ReadString('\n')
			if err != nil {
				if err == io.EOF {
					select {
					case <-ctx:
						return
					default:
					}
					if line != "" {
						m.emitLogData(self, line)
					}
					m.finishLogStream(self, true)
					return
				}
				// Non-EOF read error (e.g. session closed): still notify the
				// frontend the stream ended so it doesn't wait forever.
				select {
				case <-ctx:
				default:
					m.finishLogStream(self, true)
				}
				return
			}
			m.emitLogData(self, line)
		}
	}()

	return nil
}

// activateLogStream installs one concrete follow operation. A newer stream for
// the same container replaces and cancels the old one, while a stream ID may
// never be reused. Keeping both indexes lets StopContainerLogs target exactly
// the operation the UI started instead of accidentally stopping its successor.
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
	m.emit("docker:log", map[string]string{
		"streamID":    stream.id,
		"sessionID":   stream.sessionID,
		"containerID": stream.containerID,
		"data":        data,
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
		m.emit("docker:log", map[string]string{
			"streamID":    stream.id,
			"sessionID":   stream.sessionID,
			"containerID": stream.containerID,
			"done":        "true",
		})
	}
	return true
}

func (m *Manager) StopContainerLogs(streamID string) {
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

func (m *Manager) RestartContainer(sessionID, containerID string) error {
	if err := sanitizeDockerArg(containerID); err != nil {
		return err
	}
	cmd := fmt.Sprintf("docker restart %s", containerID)
	_, err := m.ssh.Exec(sessionID, cmd, 60*time.Second)
	if err != nil {
		return fmt.Errorf("failed to restart container: %w", err)
	}
	return nil
}

func (m *Manager) StopContainer(sessionID, containerID string) error {
	if err := sanitizeDockerArg(containerID); err != nil {
		return err
	}
	cmd := fmt.Sprintf("docker stop %s", containerID)
	_, err := m.ssh.Exec(sessionID, cmd, 30*time.Second)
	if err != nil {
		return fmt.Errorf("failed to stop container: %w", err)
	}
	return nil
}

func (m *Manager) StartContainer(sessionID, containerID string) error {
	if err := sanitizeDockerArg(containerID); err != nil {
		return err
	}
	cmd := fmt.Sprintf("docker start %s", containerID)
	_, err := m.ssh.Exec(sessionID, cmd, 30*time.Second)
	if err != nil {
		return fmt.Errorf("failed to start container: %w", err)
	}
	return nil
}

func (m *Manager) RemoveContainer(sessionID, containerID string, force bool) error {
	if err := sanitizeDockerArg(containerID); err != nil {
		return err
	}
	flag := ""
	if force {
		flag = "-f"
	}
	cmd := fmt.Sprintf("docker rm %s %s", flag, containerID)
	_, err := m.ssh.Exec(sessionID, cmd, 30*time.Second)
	if err != nil {
		return fmt.Errorf("failed to remove container: %w", err)
	}
	return nil
}

func (m *Manager) InspectContainer(sessionID, containerID string) (string, error) {
	if err := sanitizeDockerArg(containerID); err != nil {
		return "", err
	}
	cmd := fmt.Sprintf("docker inspect %s 2>&1", containerID)
	out, err := m.ssh.Exec(sessionID, cmd, 15*time.Second)
	if err != nil {
		return out, fmt.Errorf("failed to inspect container: %w", err)
	}
	return out, nil
}

func parseDockerTime(s string) int64 {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		formats := []string{
			"2006-01-02 15:04:05 -0700 MST",
			"2006-01-02 15:04:05 MST",
		}
		for _, f := range formats {
			t, err = time.Parse(f, s)
			if err == nil {
				return t.Unix()
			}
		}
		return 0
	}
	return t.Unix()
}

func ParseContainerJSON(raw string) ([]types.ContainerInfo, error) {
	var dockerContainers []struct {
		ID     string   `json:"Id"`
		Names  []string `json:"Names"`
		Image  string   `json:"Image"`
		State  string   `json:"State"`
		Status string   `json:"Status"`
		Ports  []struct {
			IP          string `json:"IP"`
			PrivatePort int    `json:"PrivatePort"`
			PublicPort  int    `json:"PublicPort"`
			Type        string `json:"Type"`
		} `json:"Ports"`
		Created int64 `json:"Created"`
	}
	if err := json.Unmarshal([]byte(raw), &dockerContainers); err != nil {
		return nil, err
	}
	var result []types.ContainerInfo
	for _, dc := range dockerContainers {
		names := make([]string, len(dc.Names))
		for i, n := range dc.Names {
			names[i] = strings.TrimPrefix(n, "/")
		}
		var portStrs []string
		for _, p := range dc.Ports {
			if p.PublicPort > 0 {
				portStrs = append(portStrs, fmt.Sprintf("%s:%d->%d/%s", p.IP, p.PublicPort, p.PrivatePort, p.Type))
			} else {
				portStrs = append(portStrs, fmt.Sprintf("%d/%s", p.PrivatePort, p.Type))
			}
		}
		shortID := dc.ID
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}
		result = append(result, types.ContainerInfo{
			ID:      shortID,
			Names:   names,
			Image:   dc.Image,
			State:   dc.State,
			Status:  dc.Status,
			Ports:   strings.Join(portStrs, ", "),
			Created: dc.Created,
		})
	}
	return result, nil
}
