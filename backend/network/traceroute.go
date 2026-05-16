package network

import (
	"bufio"
	"fmt"
	"math"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"gxShell/backend/types"
	"golang.org/x/crypto/ssh"
)

type Manager struct {
	mu       sync.Mutex
	paths    map[string]*types.NetworkPath
	pinging  map[string]chan struct{}
	emit     func(event string, data any)
	logDebug func(format string, args ...any)
}

func NewManager(emit func(event string, data any)) *Manager {
	return &Manager{
		paths:    map[string]*types.NetworkPath{},
		pinging:  map[string]chan struct{}{},
		emit:     emit,
		logDebug: func(format string, args ...any) {},
	}
}

func (m *Manager) SetLogDebug(fn func(format string, args ...any)) {
	if fn != nil {
		m.logDebug = fn
	}
}

func (m *Manager) TraceRoute(target string) (*types.NetworkPath, error) {
	var out string
	var err error

	if runtime.GOOS == "windows" {
		out, err = m.localTracert(target)
	} else {
		out, err = m.localTraceroute(target)
	}

	m.logDebug("[TraceRoute] local trace to %s output (%d bytes): %q", target, len(out), truncate(out, 800))
	_ = err

	hops := parseTraceroute(out)

	path := &types.NetworkPath{
		Target:   target,
		Hops:     hops,
		TracedAt: time.Now(),
	}

	if len(hops) > 0 {
		last := hops[len(hops)-1]
		path.TotalRTT = last.RTT1
	}

	m.mu.Lock()
	existing := m.paths[target]
	if existing != nil {
		path.PingAvg = existing.PingAvg
		path.PingMin = existing.PingMin
		path.PingMax = existing.PingMax
		path.PingLoss = existing.PingLoss
		path.Jitter = existing.Jitter
	}
	m.paths[target] = path
	m.mu.Unlock()

	return path, nil
}

func (m *Manager) localTracert(target string) (string, error) {
	cmd := exec.Command("tracert", "-d", "-w", "2000", "-h", "30", target)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000,
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (m *Manager) localTraceroute(target string) (string, error) {
	cmd := exec.Command("traceroute", "-n", "-w", "2", "-m", "30", target)
	out, err := cmd.CombinedOutput()
	if strings.TrimSpace(string(out)) == "" || strings.Contains(string(out), "command not found") {
		out2, err2 := exec.Command("tracepath", "-n", target).CombinedOutput()
		if strings.TrimSpace(string(out2)) != "" {
			return string(out2), err2
		}
	}
	return string(out), err
}

func (m *Manager) Ping(client *ssh.Client, target string, count int) (*types.NetworkPath, error) {
	if count <= 0 {
		count = 5
	}

	var rtts []float64
	for i := 0; i < count; i++ {
		start := time.Now()
		_, err := m.remoteExec(client, "echo ping")
		elapsed := time.Since(start).Seconds() * 1000
		if err != nil {
			m.logDebug("[Ping] SSH RTT measurement %d failed: %v", i+1, err)
			continue
		}
		rtts = append(rtts, elapsed)
		m.logDebug("[Ping] SSH RTT #%d: %.3f ms", i+1, elapsed)
	}

	if len(rtts) == 0 {
		return nil, fmt.Errorf("SSH RTT measurement failed: no successful samples")
	}

	var sum, minRtt, maxRtt float64
	minRtt = math.MaxFloat64
	for _, r := range rtts {
		sum += r
		if r < minRtt {
			minRtt = r
		}
		if r > maxRtt {
			maxRtt = r
		}
	}
	avg := sum / float64(len(rtts))

	var jitter float64
	if len(rtts) > 1 {
		var diffSum float64
		for i := 1; i < len(rtts); i++ {
			diffSum += math.Abs(rtts[i] - rtts[i-1])
		}
		jitter = diffSum / float64(len(rtts)-1)
	}

	m.mu.Lock()
	path := m.paths[target]
	if path == nil {
		path = &types.NetworkPath{Target: target, TracedAt: time.Now()}
		m.paths[target] = path
	}
	path.PingAvg = avg
	path.PingMin = minRtt
	path.PingMax = maxRtt
	path.PingLoss = 0
	path.Jitter = jitter
	result := *path
	m.mu.Unlock()

	m.logDebug("[Ping] result: avg=%.3f min=%.3f max=%.3f jitter=%.3f", avg, minRtt, maxRtt, jitter)
	return &result, nil
}

func (m *Manager) remoteExec(client *ssh.Client, command string) (string, error) {
	s, err := client.NewSession()
	if err != nil {
		return "", err
	}
	defer s.Close()
	var buf strings.Builder
	s.Stdout = &buf
	s.Stderr = &buf
	done := make(chan struct{})
	var runErr error
	go func() {
		runErr = s.Run(command)
		close(done)
	}()
	select {
	case <-done:
		return buf.String(), runErr
	case <-time.After(10 * time.Second):
		s.Close()
		return buf.String(), fmt.Errorf("command timed out")
	}
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

func (m *Manager) StartPing(client *ssh.Client, target string, intervalSec int) {
	if intervalSec <= 0 {
		intervalSec = 5
	}
	m.mu.Lock()
	if _, ok := m.pinging[target]; ok {
		m.mu.Unlock()
		return
	}
	stop := make(chan struct{})
	m.pinging[target] = stop
	m.mu.Unlock()

	go func() {
		ticker := time.NewTicker(time.Duration(intervalSec) * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				path, err := m.Ping(client, target, 3)
				if err == nil {
					m.emit("network:ping", path)
				}
			case <-stop:
				return
			}
		}
	}()
}

func (m *Manager) StopPing(target string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if stop, ok := m.pinging[target]; ok {
		close(stop)
		delete(m.pinging, target)
	}
}

func (m *Manager) GetPath(target string) *types.NetworkPath {
	m.mu.Lock()
	defer m.mu.Unlock()
	if p, ok := m.paths[target]; ok {
		cp := *p
		return &cp
	}
	return nil
}

func (m *Manager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for target, stop := range m.pinging {
		close(stop)
		delete(m.pinging, target)
	}
}

var (
	linuxHopRe  = regexp.MustCompile(`^\s*(\d+)\s+(\S+)\s+([\d.]+)\s*ms\s+([\d.]+)\s*ms\s+([\d.]+)\s*ms`)
	linuxHopRe2 = regexp.MustCompile(`^\s*(\d+)\s+(\S+)\s+([\d.]+)\s*ms`)
	mtrHopRe    = regexp.MustCompile(`^\s*(\d+)\.\|--\s+(\S+)\s+([\d.]+)%\s+\d+\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)`)
	tracepathRe = regexp.MustCompile(`^\s*(\d+):\s+(\S+)\s+([\d.]+)\s*ms`)
	winHopLine  = regexp.MustCompile(`^\s*(\d+)\s+`)
	winIPInLine = regexp.MustCompile(`(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})`)
)

func parseTraceroute(out string) []types.NetworkHop {
	var hops []types.NetworkHop
	scanner := bufio.NewScanner(strings.NewReader(out))

	for scanner.Scan() {
		line := scanner.Text()

		if strings.HasPrefix(line, "traceroute to") || strings.HasPrefix(line, "tracepath to") || strings.HasPrefix(line, "HOST:") || strings.HasPrefix(line, "Start:") || strings.HasPrefix(line, "Tracing route") || strings.HasPrefix(line, "over a maximum") {
			continue
		}

		if m := linuxHopRe.FindStringSubmatch(line); m != nil {
			idx, _ := strconv.Atoi(m[1])
			ip := m[2]
			r1, _ := strconv.ParseFloat(m[3], 64)
			r2, _ := strconv.ParseFloat(m[4], 64)
			r3, _ := strconv.ParseFloat(m[5], 64)
			hops = append(hops, types.NetworkHop{Index: idx, IP: ip, RTT1: r1, RTT2: r2, RTT3: r3})
			continue
		}

		if m := linuxHopRe2.FindStringSubmatch(line); m != nil {
			idx, _ := strconv.Atoi(m[1])
			ip := m[2]
			r1, _ := strconv.ParseFloat(m[3], 64)
			rtts := parseRTTs(line)
			r2, r3 := 0.0, 0.0
			if len(rtts) >= 2 {
				r2 = rtts[1]
			}
			if len(rtts) >= 3 {
				r3 = rtts[2]
			}
			hops = append(hops, types.NetworkHop{Index: idx, IP: ip, RTT1: r1, RTT2: r2, RTT3: r3})
			continue
		}

		if m := mtrHopRe.FindStringSubmatch(line); m != nil {
			idx, _ := strconv.Atoi(m[1])
			ip := m[2]
			loss, _ := strconv.ParseFloat(m[3], 64)
			last, _ := strconv.ParseFloat(m[4], 64)
			avg, _ := strconv.ParseFloat(m[5], 64)
			best, _ := strconv.ParseFloat(m[6], 64)
			worst, _ := strconv.ParseFloat(m[7], 64)
			hops = append(hops, types.NetworkHop{Index: idx, IP: ip, RTT1: last, RTT2: avg, RTT3: best, Loss: loss, Jitter: worst - best})
			continue
		}

		if m := tracepathRe.FindStringSubmatch(line); m != nil {
			idx, _ := strconv.Atoi(m[1])
			ip := m[2]
			rtt, _ := strconv.ParseFloat(m[3], 64)
			hops = append(hops, types.NetworkHop{Index: idx, IP: ip, RTT1: rtt})
			continue
		}

		if winHopLine.MatchString(line) {
			indexStr := strings.TrimSpace(winHopLine.FindStringSubmatch(line)[1])
			idx, _ := strconv.Atoi(indexStr)
			if idx == 0 {
				continue
			}
			if strings.Contains(line, "* * *") || strings.Contains(line, "请求超时") || strings.Contains(line, "timed out") || strings.TrimSpace(line[strings.Index(line, " ")+1:]) == "*" {
				hops = append(hops, types.NetworkHop{Index: idx, Timeout: true})
				continue
			}
			ips := winIPInLine.FindAllString(line, -1)
			rtts := parseRTTs(line)
			if len(ips) == 0 {
				hops = append(hops, types.NetworkHop{Index: idx, Timeout: true})
				continue
			}
			ip := ips[0]
			r1, r2, r3 := 0.0, 0.0, 0.0
			if len(rtts) >= 1 {
				r1 = rtts[0]
			}
			if len(rtts) >= 2 {
				r2 = rtts[1]
			}
			if len(rtts) >= 3 {
				r3 = rtts[2]
			}
			hops = append(hops, types.NetworkHop{Index: idx, IP: ip, RTT1: r1, RTT2: r2, RTT3: r3})
			continue
		}
	}

	return hops
}

var rttRe = regexp.MustCompile(`([\d.]+)\s*ms`)

func parseRTTs(line string) []float64 {
	matches := rttRe.FindAllStringSubmatch(line, -1)
	var rtts []float64
	for _, m := range matches {
		v, err := strconv.ParseFloat(m[1], 64)
		if err == nil {
			rtts = append(rtts, v)
		}
	}
	return rtts
}
