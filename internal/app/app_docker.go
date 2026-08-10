package app

import (
	"gxShell/backend/logger"
	"gxShell/backend/types"
)

// ListContainers returns Docker containers on the remote host.
func (a *App) ListContainers(sessionID string, all bool) ([]types.ContainerInfo, error) {
	return a.docker.ListContainers(sessionID, all)
}

// ContainerLogs retrieves logs from a Docker container.
func (a *App) ContainerLogs(sessionID, containerID string, tail int) (string, error) {
	return a.docker.ContainerLogs(sessionID, containerID, tail)
}

// StreamContainerLogs streams Docker container logs in real-time.
func (a *App) StreamContainerLogs(sessionID, containerID, streamID string, tail int) error {
	return a.docker.StreamContainerLogs(sessionID, containerID, streamID, tail)
}

// StopContainerLogs stops exactly one log-follow operation.
func (a *App) StopContainerLogs(streamID string) {
	a.docker.StopContainerLogs(streamID)
}

// RestartContainer restarts a Docker container.
func (a *App) RestartContainer(sessionID, containerID string) error {
	return a.auditSimpleGUIChange("container.restart", containerID, sessionID, nil, func() error {
		return a.docker.RestartContainer(sessionID, containerID)
	})
}

// StopContainer stops a running Docker container.
func (a *App) StopContainer(sessionID, containerID string) error {
	return a.auditSimpleGUIChange("container.stop", containerID, sessionID, nil, func() error {
		return a.docker.StopContainer(sessionID, containerID)
	})
}

// StartContainer starts a stopped Docker container.
func (a *App) StartContainer(sessionID, containerID string) error {
	return a.auditSimpleGUIChange("container.start", containerID, sessionID, nil, func() error {
		return a.docker.StartContainer(sessionID, containerID)
	})
}

// RemoveContainer removes a Docker container.
func (a *App) RemoveContainer(sessionID, containerID string, force bool) error {
	return a.auditSimpleGUIChange("container.remove", containerID, sessionID, logger.LogFields{"force": force}, func() error {
		return a.docker.RemoveContainer(sessionID, containerID, force)
	})
}
