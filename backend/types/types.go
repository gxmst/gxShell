package types

import "time"

type AuthType string

const (
	AuthPassword   AuthType = "password"
	AuthPrivateKey AuthType = "privateKey"
)

type Profile struct {
	ID                   string    `json:"id"`
	Name                 string    `json:"name"`
	Group                string    `json:"group"`
	Host                 string    `json:"host"`
	Port                 int       `json:"port"`
	Username             string    `json:"username"`
	AuthType             AuthType  `json:"authType"`
	Password             string    `json:"password,omitempty"`
	PrivateKeyPath       string    `json:"privateKeyPath,omitempty"`
	PrivateKeyPassphrase string    `json:"privateKeyPassphrase,omitempty"`
	RememberPassword     bool      `json:"rememberPassword"`
	Description          string    `json:"description"`
	Tags                 []string  `json:"tags"`
	Favorite             bool      `json:"favorite"`
	LastConnectedAt      time.Time `json:"lastConnectedAt,omitempty"`
	CreatedAt            time.Time `json:"createdAt"`
	UpdatedAt            time.Time `json:"updatedAt"`
}

type AppSettings struct {
	ThemeName           string           `json:"themeName"`
	Language            string           `json:"language"`
	Terminal            TerminalSettings `json:"terminal"`
	MonitorEnabled      bool             `json:"monitorEnabled"`
	MonitorIntervalSec  int              `json:"monitorIntervalSec"`
	ConnectionTimeout   int              `json:"connectionTimeout"`
	HighlightLevel      string           `json:"highlightLevel"`
	SidebarWidth        int              `json:"sidebarWidth"`
	SidebarSplitPct     int              `json:"sidebarSplitPct"`
	SavePasswords       bool             `json:"savePasswords"`
	SmartHighlight      bool             `json:"smartHighlight"`
	ConfirmOnDisconnect bool             `json:"confirmOnDisconnect"`
}

type TerminalSettings struct {
	FontFamily        string  `json:"fontFamily"`
	FontSize          int     `json:"fontSize"`
	LineHeight        float64 `json:"lineHeight"`
	CursorStyle       string  `json:"cursorStyle"`
	CursorBlink       bool    `json:"cursorBlink"`
	ThemeName         string  `json:"themeName"`
	BackgroundOpacity float64 `json:"backgroundOpacity"`
	ScrollbackLines   int     `json:"scrollbackLines"`
}

type CommandTemplate struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Command     string    `json:"command"`
	Category    string    `json:"category"`
	Description string    `json:"description"`
	Tags        []string  `json:"tags"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type SessionState string

const (
	SessionConnecting   SessionState = "connecting"
	SessionConnected    SessionState = "connected"
	SessionDisconnected SessionState = "disconnected"
	SessionError        SessionState = "error"
)

type SessionInfo struct {
	ID        string       `json:"id"`
	ProfileID string       `json:"profileId"`
	Name      string       `json:"name"`
	State     SessionState `json:"state"`
	Error     string       `json:"error,omitempty"`
	Cols      int          `json:"cols"`
	Rows      int          `json:"rows"`
	StartedAt time.Time    `json:"startedAt"`
}

type RemoteFile struct {
	Name        string    `json:"name"`
	Path        string    `json:"path"`
	Size        int64     `json:"size"`
	IsDir       bool      `json:"isDir"`
	Mode        string    `json:"mode"`
	ModTime     time.Time `json:"modTime"`
	Permissions string    `json:"permissions"`
}

type Metrics struct {
	SessionID       string        `json:"sessionId"`
	Online          bool          `json:"online"`
	Host            string        `json:"host"`
	Uptime          string        `json:"uptime"`
	LoadAverage     string        `json:"loadAverage"`
	CPUPercent      float64       `json:"cpuPercent"`
	MemoryUsedMB    int64         `json:"memoryUsedMb"`
	MemoryTotalMB   int64         `json:"memoryTotalMb"`
	MemoryPercent   float64       `json:"memoryPercent"`
	SwapUsedMB      int64         `json:"swapUsedMb"`
	SwapTotalMB     int64         `json:"swapTotalMb"`
	DiskUsed        string        `json:"diskUsed"`
	DiskTotal       string        `json:"diskTotal"`
	DiskPercent     float64       `json:"diskPercent"`
	NetworkRxPerSec int64         `json:"networkRxPerSec"`
	NetworkTxPerSec int64         `json:"networkTxPerSec"`
	LatencyMs       int64         `json:"latencyMs"`
	TopProcesses    []ProcessInfo `json:"topProcesses"`
	UpdatedAt       time.Time     `json:"updatedAt"`
	Error           string        `json:"error,omitempty"`
}

type ProcessInfo struct {
	User    string  `json:"user"`
	PID     string  `json:"pid"`
	CPU     float64 `json:"cpu"`
	Memory  float64 `json:"memory"`
	Command string  `json:"command"`
}

type LogEntry struct {
	Time    time.Time `json:"time"`
	Level   string    `json:"level"`
	Message string    `json:"message"`
}
