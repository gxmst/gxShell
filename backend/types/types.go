package types

import "time"

type AuthType string

const (
	AuthPassword   AuthType = "password"
	AuthPrivateKey AuthType = "privateKey"
	// AuthAgent authenticates with keys held by the running SSH agent (the
	// Windows OpenSSH Authentication Agent service, or SSH_AUTH_SOCK
	// elsewhere). No secret is stored or prompted for.
	AuthAgent AuthType = "agent"
)

type Profile struct {
	ID                   string   `json:"id"`
	Name                 string   `json:"name"`
	Group                string   `json:"group"`
	Host                 string   `json:"host"`
	Port                 int      `json:"port"`
	Username             string   `json:"username"`
	AuthType             AuthType `json:"authType"`
	Password             string   `json:"password,omitempty"`
	PrivateKeyPath       string   `json:"privateKeyPath,omitempty"`
	PrivateKeyPassphrase string   `json:"privateKeyPassphrase,omitempty"`
	RememberPassword     bool     `json:"rememberPassword"`
	ProxyJumpID          string   `json:"proxyJumpId,omitempty"`
	Description          string   `json:"description"`
	Tags                 []string `json:"tags"`
	Favorite             bool     `json:"favorite"`
	// CliEnabled opts a profile in to the external gxshell-cli interface. When
	// false the CLI cannot see, list, or execute against this profile. This is a
	// CLI-only flag; the in-app AI assistant operates on the active session and
	// always requires a per-command native confirmation regardless of this value.
	CliEnabled bool   `json:"cliEnabled"`
	CliAlias   string `json:"cliAlias,omitempty"`
	// Deprecated: legacyAIEnabled/legacyAIAlias hold values written by versions
	// that named this flag "aiEnabled"/"aiAlias". They are migrated into
	// CliEnabled/CliAlias on startup (see App.migrateCliProfileFlags) and then
	// cleared, so they only exist to avoid losing an existing user's opt-in.
	LegacyAIEnabled bool         `json:"aiEnabled,omitempty"`
	LegacyAIAlias   string       `json:"aiAlias,omitempty"`
	Tunnels         []TunnelRule `json:"tunnels"`
	AutoReconnect   bool         `json:"autoReconnect"`
	LastConnectedAt time.Time    `json:"lastConnectedAt,omitempty"`
	CreatedAt       time.Time    `json:"createdAt"`
	UpdatedAt       time.Time    `json:"updatedAt"`
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
	// CliServerEnabled controls whether the local gxshell-cli HTTP server runs.
	// When false the server does not listen at all, so no local process can use
	// the CLI interface regardless of per-profile opt-in. Defaults to true.
	CliServerEnabled bool     `json:"cliServerEnabled"`
	Ai               AiConfig `json:"ai"`
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
	// LocalShell is an optional executable name or absolute path used for new
	// local terminals. Empty and "auto" keep the platform default.
	LocalShell string `json:"localShell,omitempty"`
	// LocalStartDirectory is expanded when a local terminal is opened. Empty
	// means the current user's home directory.
	LocalStartDirectory string `json:"localStartDirectory,omitempty"`
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

type TunnelType string

const (
	TunnelLocal   TunnelType = "local"
	TunnelRemote  TunnelType = "remote"
	TunnelDynamic TunnelType = "dynamic"
)

type TunnelRule struct {
	ID       string     `json:"id"`
	Type     TunnelType `json:"type"`
	Local    string     `json:"local"`
	Remote   string     `json:"remote"`
	BindHost string     `json:"bindHost,omitempty"`
}

type TunnelStatus struct {
	Rule   TunnelRule `json:"rule"`
	Active bool       `json:"active"`
	Error  string     `json:"error,omitempty"`
}

type NetworkHop struct {
	Index   int     `json:"index"`
	Host    string  `json:"host"`
	IP      string  `json:"ip"`
	RTT1    float64 `json:"rtt1"`
	RTT2    float64 `json:"rtt2"`
	RTT3    float64 `json:"rtt3"`
	Timeout bool    `json:"timeout"`
	Loss    float64 `json:"loss"`
	Jitter  float64 `json:"jitter"`
}

type NetworkPath struct {
	Target   string       `json:"target"`
	Hops     []NetworkHop `json:"hops"`
	TotalRTT float64      `json:"totalRtt"`
	PingAvg  float64      `json:"pingAvg"`
	PingMin  float64      `json:"pingMin"`
	PingMax  float64      `json:"pingMax"`
	PingLoss float64      `json:"pingLoss"`
	Jitter   float64      `json:"jitter"`
	TracedAt time.Time    `json:"tracedAt"`
}

type LocalFile struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	IsDir   bool      `json:"isDir"`
	ModTime time.Time `json:"modTime"`
}

type LogFile struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
}

type Recording struct {
	Name    string    `json:"name"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"modTime"`
}

type AiConfig struct {
	Provider string `json:"provider"`
	APIKey   string `json:"apiKey"`
	Endpoint string `json:"endpoint"`
	Model    string `json:"model"`
}

type AiFunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type AiToolCall struct {
	ID       string         `json:"id"`
	Type     string         `json:"type"`
	Function AiFunctionCall `json:"function"`
}

type AiMessage struct {
	Role             string       `json:"role"`
	Content          string       `json:"content"`
	ReasoningContent string       `json:"reasoningContent,omitempty"`
	ToolCalls        []AiToolCall `json:"toolCalls,omitempty"`
	ToolCallID       string       `json:"toolCallId,omitempty"`
}

type AiToolResult struct {
	ToolCallID string `json:"toolCallId"`
	Content    string `json:"content"`
}

type AiChatRequest struct {
	Messages    []AiMessage `json:"messages"`
	Context     string      `json:"context"`
	SessionID   string      `json:"sessionId"`
	ChatID      string      `json:"chatId"`
	RequestID   string      `json:"requestId"`
	EnableTools bool        `json:"enableTools"`
}

type AiTokenUsage struct {
	PromptTokens     int64 `json:"promptTokens"`
	CompletionTokens int64 `json:"completionTokens"`
	TotalTokens      int64 `json:"totalTokens"`
}

type ServiceInfo struct {
	Name        string `json:"name"` // full unit name, e.g. "nginx.service"
	Description string `json:"description"`
	LoadState   string `json:"loadState"`   // loaded|not-found|masked
	ActiveState string `json:"activeState"` // active|inactive|failed|activating|deactivating
	SubState    string `json:"subState"`    // running|exited|dead|...
	Enabled     string `json:"enabled"`     // enabled|disabled|static|masked|"" when unknown
}

type FirewallRule struct {
	Index    int    `json:"index"`    // ufw numbered index (1-based); -1 for firewalld
	Raw      string `json:"raw"`      // raw rule text (ufw numbered line body / firewalld port or rich-rule string)
	Action   string `json:"action"`   // allow|deny|reject|limit
	Port     string `json:"port"`     // "8080" or "8000:8100" (normalized with ':' for ranges); may be "" for non-port rules
	Protocol string `json:"protocol"` // tcp|udp|""
	Source   string `json:"source"`   // CIDR/IP or "" meaning anywhere
	V6       bool   `json:"v6"`
}

type FirewallStatus struct {
	Backend       string         `json:"backend"` // "ufw" | "firewalld" | "none"
	Enabled       bool           `json:"enabled"`
	DefaultPolicy string         `json:"defaultPolicy"` // ufw: e.g. "deny (incoming), allow (outgoing)"; firewalld: default zone name
	SSHPort       int            `json:"sshPort"`       // the port of THIS session's SSH connection (for lockout warnings in the UI)
	Rules         []FirewallRule `json:"rules"`
}

type ContainerInfo struct {
	ID      string   `json:"id"`
	Names   []string `json:"names"`
	Image   string   `json:"image"`
	State   string   `json:"state"`
	Status  string   `json:"status"`
	Ports   string   `json:"ports"`
	Created int64    `json:"created"`
}
