export type LangKey =
  | "monitor" | "files" | "cmd" | "settings"
  | "servers" | "new" | "search" | "currentServer"
  | "noServers" | "connectFirstSftp" | "openTerminal"
  | "noActiveTerminal" | "noActiveTerminalHint" | "newConnection" | "openCmdPalette"
  | "collapse" | "lang" | "theme" | "termTheme" | "font" | "size"
  | "monitorInterval" | "timeout" | "enableMonitor" | "highlightOutput"
  | "confirmClose" | "save" | "openData"
  | "cpu" | "mem" | "disk" | "load" | "ping" | "down" | "up"
  | "topProcesses" | "startMonitor" | "newCommand"
  | "loading" | "cancel" | "connect" | "enterPassword" | "enterPassphrase"
  | "showSecret" | "downloadFinished" | "uploading" | "downloading"
  | "progressDownload" | "progressUpload"
  | "hostKeyTitle" | "hostKeyMessage"
  | "copyToClipboard" | "all" | "none"
  | "confirmDisconnectBody";

const en: Record<LangKey, string> = {
  monitor: "Monitor",
  files: "Files",
  cmd: "Cmd",
  settings: "Settings",
  servers: "Servers",
  new: "New",
  search: "Search",
  currentServer: "Current Server",
  noServers: "No servers yet. Create one to begin.",
  connectFirstSftp: "Connect first to browse SFTP.",
  openTerminal: "Open a terminal to view live status.",
  noActiveTerminal: "No active terminal",
  noActiveTerminalHint: "Double click a server, or press Ctrl+K to search.",
  newConnection: "New connection",
  openCmdPalette: "Open command palette",
  collapse: "Collapse sidebar",
  lang: "Language",
  theme: "Theme",
  termTheme: "Term theme",
  font: "Font",
  size: "Size",
  monitorInterval: "Monitor",
  timeout: "Timeout",
  enableMonitor: "Enable monitor",
  highlightOutput: "Highlight command output",
  confirmClose: "Confirm before close",
  save: "Save",
  openData: "Open data",
  cpu: "CPU",
  mem: "Mem",
  disk: "Disk",
  load: "Load",
  ping: "Ping",
  down: "Down",
  up: "Up",
  topProcesses: "Top processes",
  startMonitor: "Start monitor",
  newCommand: "New command",
  loading: "Loading...",
  cancel: "Cancel",
  connect: "Connect",
  enterPassword: "Enter SSH password",
  enterPassphrase: "Enter key passphrase",
  showSecret: "Show secret",
  downloadFinished: "Download finished",
  uploading: "Uploading",
  downloading: "Downloading",
  progressDownload: "Downloading {name}",
  progressUpload: "Uploading {name}",
  hostKeyTitle: "Unknown Host Key",
  hostKeyMessage: "The host key for {host} is unknown.\nFingerprint: {fp}\n\nDo you want to trust this host and continue connecting?",
  copyToClipboard: "Copied to clipboard",
  all: "All",
  none: "None",
  confirmDisconnectBody: "Disconnect {name}? The terminal session will be closed.",
};

const zhCN: Record<LangKey, string> = {
  monitor: "监控",
  files: "文件",
  cmd: "命令",
  settings: "设置",
  servers: "服务器",
  new: "新建",
  search: "搜索",
  currentServer: "当前服务器",
  noServers: "暂无服务器，创建一个开始使用。",
  connectFirstSftp: "请先连接服务器以浏览文件。",
  openTerminal: "打开终端查看实时状态。",
  noActiveTerminal: "无活动终端",
  noActiveTerminalHint: "双击服务器或按 Ctrl+K 搜索。",
  newConnection: "新建连接",
  openCmdPalette: "打开命令面板",
  collapse: "折叠侧栏",
  lang: "语言",
  theme: "主题",
  termTheme: "终端主题",
  font: "字体",
  size: "字号",
  monitorInterval: "监控",
  timeout: "超时",
  enableMonitor: "启用监控",
  highlightOutput: "高亮命令输出",
  confirmClose: "关闭前确认",
  save: "保存",
  openData: "打开数据",
  cpu: "CPU",
  mem: "内存",
  disk: "磁盘",
  load: "负载",
  ping: "延迟",
  down: "下行",
  up: "上行",
  topProcesses: "进程排行",
  startMonitor: "启动监控",
  newCommand: "新建命令",
  loading: "加载中...",
  cancel: "取消",
  connect: "连接",
  enterPassword: "输入 SSH 密码",
  enterPassphrase: "输入密钥密码",
  showSecret: "显示密钥",
  downloadFinished: "下载完成",
  uploading: "正在上传",
  downloading: "正在下载",
  progressDownload: "正在下载 {name}",
  progressUpload: "正在上传 {name}",
  hostKeyTitle: "未知主机密钥",
  hostKeyMessage: "主机 {host} 的密钥未知。\n指纹: {fp}\n\n是否信任该主机并继续连接？",
  copyToClipboard: "已复制到剪贴板",
  all: "全部",
  none: "无",
  confirmDisconnectBody: "断开 {name}？终端会话将被关闭。",
};

const locales: Record<string, Record<LangKey, string>> = { en, "zh-CN": zhCN };

export function t(locale: string, key: LangKey, params?: Record<string, string>): string {
  const text = locales[locale]?.[key] || locales["en"]?.[key] || key;
  if (!params) return text;
  return Object.entries(params).reduce((acc, [k, v]) => acc.replace(`{${k}}`, v), text);
}

export function navLabel(key: string, locale: string): string {
  const map: Record<string, LangKey> = {
    monitor: "monitor",
    sftp: "files",
    commands: "cmd",
    settings: "settings",
  };
  return t(locale, map[key] || (key as LangKey));
}
