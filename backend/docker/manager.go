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
	logCancels map[string]*logStream
}

// logStream identifies a single log-follow goroutine. The pointer doubles as the
// identity token: a teardown only removes the map entry if it still points at
// itself, so a superseded stream can't delete the entry of the one that replaced
// it.
type logStream struct {
	cancel func()
	once   sync.Once
}

func NewManager(sshMgr *sshmanager.Manager) *Manager {
	return &Manager{
		ssh:        sshMgr,
		emit:       func(event string, data any) {},
		logCancels: make(map[string]*logStream),
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

func (m *Manager) StreamContainerLogs(sessionID, containerID string, tail int) error {
	if err := sanitizeDockerArg(containerID); err != nil {
		return err
	}
	if err := sanitizeTailArg(tail); err != nil {
		return err
	}
	key := sessionID + ":" + containerID

	m.mu.Lock()
	if existing, ok := m.logCancels[key]; ok {
		existing.cancel()
		delete(m.logCancels, key)
	}
	m.mu.Unlock()

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
	self := &logStream{}
	self.cancel = func() { self.once.Do(func() { close(ctx); _ = session.Close() }) }
	m.mu.Lock()
	m.logCancels[key] = self
	m.mu.Unlock()

	go func() {
		defer func() {
			_ = session.Close()
			m.mu.Lock()
			// Only remove the map entry if it still points at this stream. A newer
			// StreamContainerLogs for the same key may have replaced it; deleting
			// blindly would orphan that newer stream (it could no longer be stopped).
			if cur, ok := m.logCancels[key]; ok && cur == self {
				delete(m.logCancels, key)
			}
			m.mu.Unlock()
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
						m.emit("docker:log", map[string]string{"containerID": containerID, "data": line})
					}
					m.emit("docker:log", map[string]string{"containerID": containerID, "done": "true"})
					return
				}
				// Non-EOF read error (e.g. session closed): still notify the
				// frontend the stream ended so it doesn't wait forever.
				select {
				case <-ctx:
				default:
					m.emit("docker:log", map[string]string{"containerID": containerID, "done": "true"})
				}
				return
			}
			m.emit("docker:log", map[string]string{"containerID": containerID, "data": line})
		}
	}()

	return nil
}

func (m *Manager) StopContainerLogs(sessionID, containerID string) {
	key := sessionID + ":" + containerID
	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.logCancels[key]; ok {
		existing.cancel()
		delete(m.logCancels, key)
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
