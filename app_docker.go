package main

import "gxShell/backend/types"

// ListContainers returns Docker containers on the remote host.
func (a *App) ListContainers(sessionID string, all bool) ([]types.ContainerInfo, error) {
	return a.docker.ListContainers(sessionID, all)
}

// ContainerLogs retrieves logs from a Docker container.
func (a *App) ContainerLogs(sessionID, containerID string, tail int) (string, error) {
	return a.docker.ContainerLogs(sessionID, containerID, tail)
}

// StreamContainerLogs streams Docker container logs in real-time.
func (a *App) StreamContainerLogs(sessionID, containerID string, tail int) error {
	return a.docker.StreamContainerLogs(sessionID, containerID, tail)
}

// StopContainerLogs stops streaming logs for a container.
func (a *App) StopContainerLogs(sessionID, containerID string) {
	a.docker.StopContainerLogs(sessionID, containerID)
}

// RestartContainer restarts a Docker container.
func (a *App) RestartContainer(sessionID, containerID string) error {
	return a.docker.RestartContainer(sessionID, containerID)
}

// StopContainer stops a running Docker container.
func (a *App) StopContainer(sessionID, containerID string) error {
	return a.docker.StopContainer(sessionID, containerID)
}

// StartContainer starts a stopped Docker container.
func (a *App) StartContainer(sessionID, containerID string) error {
	return a.docker.StartContainer(sessionID, containerID)
}

// RemoveContainer removes a Docker container.
func (a *App) RemoveContainer(sessionID, containerID string, force bool) error {
	return a.docker.RemoveContainer(sessionID, containerID, force)
}
