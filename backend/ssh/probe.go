package sshmanager

import (
	"time"

	"gxShell/backend/network"
	"gxShell/backend/types"
)

// ProbeConnection samples the established route. Proxies and jump hosts may
// resolve names privately, so those sessions are probed inside their SSH channel.
func (m *Manager) ProbeConnection(id string) *types.ProbeSample {
	session, err := m.get(id)
	if err != nil {
		return nil
	}
	session.mu.RLock()
	peer, shell := session.probeIP, session.shell
	session.mu.RUnlock()
	if shell == nil {
		return nil
	}
	const timeout = 2 * time.Second
	sample := &types.ProbeSample{At: time.Now(), Method: "icmp"}
	if peer.IsValid() {
		sample.State, sample.RTTMs = network.Echo(peer, timeout)
		return sample
	}
	// A timed-out channel request stays in flight until a reply or disconnect.
	// Never queue another request behind it or double-count the missing reply.
	if !session.probeMu.TryLock() {
		return nil
	}
	sample.Method = "ssh"
	reply := make(chan error, 1)
	go func() {
		defer session.probeMu.Unlock()
		_, err := shell.SendRequest("keepalive@openssh.com", true, nil)
		reply <- err
	}()
	select {
	case err := <-reply:
		if err == nil {
			// A server's explicit REQUEST_FAILURE is also a round trip.
			sample.State = "reply"
			sample.RTTMs = float64(time.Since(sample.At)) / float64(time.Millisecond)
		} else {
			sample.State = "lost"
		}
	case <-time.After(timeout):
		sample.State = "lost"
	case <-session.done:
		return nil
	}
	return sample
}
