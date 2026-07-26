export namespace sshmanager {
	
	export class KnownHostEntry {
	    hosts: string;
	    keyType: string;
	    fingerprint: string;
	
	    static createFrom(source: any = {}) {
	        return new KnownHostEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.hosts = source["hosts"];
	        this.keyType = source["keyType"];
	        this.fingerprint = source["fingerprint"];
	    }
	}

}

export namespace types {
	
	export class AiFunctionCall {
	    name: string;
	    arguments: string;
	
	    static createFrom(source: any = {}) {
	        return new AiFunctionCall(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.arguments = source["arguments"];
	    }
	}
	export class AiToolCall {
	    id: string;
	    type: string;
	    function: AiFunctionCall;
	
	    static createFrom(source: any = {}) {
	        return new AiToolCall(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.type = source["type"];
	        this.function = this.convertValues(source["function"], AiFunctionCall);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AiMessage {
	    role: string;
	    content: string;
	    reasoningContent?: string;
	    toolCalls?: AiToolCall[];
	    toolCallId?: string;
	
	    static createFrom(source: any = {}) {
	        return new AiMessage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.role = source["role"];
	        this.content = source["content"];
	        this.reasoningContent = source["reasoningContent"];
	        this.toolCalls = this.convertValues(source["toolCalls"], AiToolCall);
	        this.toolCallId = source["toolCallId"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AiChatRequest {
	    messages: AiMessage[];
	    context: string;
	    sessionId: string;
	    chatId: string;
	    requestId: string;
	    enableTools: boolean;
	
	    static createFrom(source: any = {}) {
	        return new AiChatRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.messages = this.convertValues(source["messages"], AiMessage);
	        this.context = source["context"];
	        this.sessionId = source["sessionId"];
	        this.chatId = source["chatId"];
	        this.requestId = source["requestId"];
	        this.enableTools = source["enableTools"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class AiConfig {
	    provider: string;
	    apiKey: string;
	    endpoint: string;
	    model: string;
	
	    static createFrom(source: any = {}) {
	        return new AiConfig(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.provider = source["provider"];
	        this.apiKey = source["apiKey"];
	        this.endpoint = source["endpoint"];
	        this.model = source["model"];
	    }
	}
	
	
	export class AiTokenUsage {
	    promptTokens: number;
	    completionTokens: number;
	    totalTokens: number;
	
	    static createFrom(source: any = {}) {
	        return new AiTokenUsage(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.promptTokens = source["promptTokens"];
	        this.completionTokens = source["completionTokens"];
	        this.totalTokens = source["totalTokens"];
	    }
	}
	
	export class TerminalSettings {
	    fontFamily: string;
	    fontSize: number;
	    lineHeight: number;
	    cursorStyle: string;
	    cursorBlink: boolean;
	    themeName: string;
	    backgroundOpacity: number;
	    scrollbackLines: number;
	    localShell?: string;
	    localStartDirectory?: string;
	
	    static createFrom(source: any = {}) {
	        return new TerminalSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fontFamily = source["fontFamily"];
	        this.fontSize = source["fontSize"];
	        this.lineHeight = source["lineHeight"];
	        this.cursorStyle = source["cursorStyle"];
	        this.cursorBlink = source["cursorBlink"];
	        this.themeName = source["themeName"];
	        this.backgroundOpacity = source["backgroundOpacity"];
	        this.scrollbackLines = source["scrollbackLines"];
	        this.localShell = source["localShell"];
	        this.localStartDirectory = source["localStartDirectory"];
	    }
	}
	export class AppSettings {
	    themeName: string;
	    language: string;
	    terminal: TerminalSettings;
	    monitorEnabled: boolean;
	    monitorIntervalSec: number;
	    connectionTimeout: number;
	    highlightLevel: string;
	    sidebarWidth: number;
	    sidebarSplitPct: number;
	    savePasswords: boolean;
	    smartHighlight: boolean;
	    confirmOnDisconnect: boolean;
	    cliServerEnabled: boolean;
	    updateCheckEnabled: boolean;
	    updateSkippedVersion?: string;
	    ai: AiConfig;
	
	    static createFrom(source: any = {}) {
	        return new AppSettings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.themeName = source["themeName"];
	        this.language = source["language"];
	        this.terminal = this.convertValues(source["terminal"], TerminalSettings);
	        this.monitorEnabled = source["monitorEnabled"];
	        this.monitorIntervalSec = source["monitorIntervalSec"];
	        this.connectionTimeout = source["connectionTimeout"];
	        this.highlightLevel = source["highlightLevel"];
	        this.sidebarWidth = source["sidebarWidth"];
	        this.sidebarSplitPct = source["sidebarSplitPct"];
	        this.savePasswords = source["savePasswords"];
	        this.smartHighlight = source["smartHighlight"];
	        this.confirmOnDisconnect = source["confirmOnDisconnect"];
	        this.cliServerEnabled = source["cliServerEnabled"];
	        this.updateCheckEnabled = source["updateCheckEnabled"];
	        this.updateSkippedVersion = source["updateSkippedVersion"];
	        this.ai = this.convertValues(source["ai"], AiConfig);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CommandTemplate {
	    id: string;
	    name: string;
	    command: string;
	    category: string;
	    description: string;
	    tags: string[];
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    updatedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new CommandTemplate(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.command = source["command"];
	        this.category = source["category"];
	        this.description = source["description"];
	        this.tags = source["tags"];
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.updatedAt = this.convertValues(source["updatedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ContainerInfo {
	    id: string;
	    names: string[];
	    image: string;
	    state: string;
	    status: string;
	    ports: string;
	    created: number;
	
	    static createFrom(source: any = {}) {
	        return new ContainerInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.names = source["names"];
	        this.image = source["image"];
	        this.state = source["state"];
	        this.status = source["status"];
	        this.ports = source["ports"];
	        this.created = source["created"];
	    }
	}
	export class CronJob {
	    id: string;
	    schedule: string;
	    command: string;
	    enabled: boolean;
	
	    static createFrom(source: any = {}) {
	        return new CronJob(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.schedule = source["schedule"];
	        this.command = source["command"];
	        this.enabled = source["enabled"];
	    }
	}
	export class FirewallRule {
	    index: number;
	    raw: string;
	    action: string;
	    port: string;
	    protocol: string;
	    source: string;
	    v6: boolean;
	
	    static createFrom(source: any = {}) {
	        return new FirewallRule(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.raw = source["raw"];
	        this.action = source["action"];
	        this.port = source["port"];
	        this.protocol = source["protocol"];
	        this.source = source["source"];
	        this.v6 = source["v6"];
	    }
	}
	export class FirewallStatus {
	    backend: string;
	    enabled: boolean;
	    defaultPolicy: string;
	    sshPort: number;
	    rules: FirewallRule[];
	
	    static createFrom(source: any = {}) {
	        return new FirewallStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.backend = source["backend"];
	        this.enabled = source["enabled"];
	        this.defaultPolicy = source["defaultPolicy"];
	        this.sshPort = source["sshPort"];
	        this.rules = this.convertValues(source["rules"], FirewallRule);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LocalFile {
	    name: string;
	    path: string;
	    size: number;
	    isDir: boolean;
	    // Go type: time
	    modTime: any;
	
	    static createFrom(source: any = {}) {
	        return new LocalFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.size = source["size"];
	        this.isDir = source["isDir"];
	        this.modTime = this.convertValues(source["modTime"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LogEntry {
	    // Go type: time
	    time: any;
	    level: string;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new LogEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.time = this.convertValues(source["time"], null);
	        this.level = source["level"];
	        this.message = source["message"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class LogFile {
	    name: string;
	    path: string;
	    size: number;
	    // Go type: time
	    modTime: any;
	
	    static createFrom(source: any = {}) {
	        return new LogFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.size = source["size"];
	        this.modTime = this.convertValues(source["modTime"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ProcessInfo {
	    user: string;
	    pid: string;
	    cpu: number;
	    memory: number;
	    command: string;
	
	    static createFrom(source: any = {}) {
	        return new ProcessInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.user = source["user"];
	        this.pid = source["pid"];
	        this.cpu = source["cpu"];
	        this.memory = source["memory"];
	        this.command = source["command"];
	    }
	}
	export class Metrics {
	    sessionId: string;
	    online: boolean;
	    host: string;
	    uptime: string;
	    loadAverage: string;
	    cpuPercent: number;
	    memoryUsedMb: number;
	    memoryTotalMb: number;
	    memoryPercent: number;
	    swapUsedMb: number;
	    swapTotalMb: number;
	    diskUsed: string;
	    diskTotal: string;
	    diskPercent: number;
	    networkRxPerSec: number;
	    networkTxPerSec: number;
	    latencyMs: number;
	    topProcesses: ProcessInfo[];
	    // Go type: time
	    updatedAt: any;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new Metrics(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.sessionId = source["sessionId"];
	        this.online = source["online"];
	        this.host = source["host"];
	        this.uptime = source["uptime"];
	        this.loadAverage = source["loadAverage"];
	        this.cpuPercent = source["cpuPercent"];
	        this.memoryUsedMb = source["memoryUsedMb"];
	        this.memoryTotalMb = source["memoryTotalMb"];
	        this.memoryPercent = source["memoryPercent"];
	        this.swapUsedMb = source["swapUsedMb"];
	        this.swapTotalMb = source["swapTotalMb"];
	        this.diskUsed = source["diskUsed"];
	        this.diskTotal = source["diskTotal"];
	        this.diskPercent = source["diskPercent"];
	        this.networkRxPerSec = source["networkRxPerSec"];
	        this.networkTxPerSec = source["networkTxPerSec"];
	        this.latencyMs = source["latencyMs"];
	        this.topProcesses = this.convertValues(source["topProcesses"], ProcessInfo);
	        this.updatedAt = this.convertValues(source["updatedAt"], null);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class NetworkHop {
	    index: number;
	    host: string;
	    ip: string;
	    rtt1: number;
	    rtt2: number;
	    rtt3: number;
	    timeout: boolean;
	    loss: number;
	    jitter: number;
	
	    static createFrom(source: any = {}) {
	        return new NetworkHop(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.index = source["index"];
	        this.host = source["host"];
	        this.ip = source["ip"];
	        this.rtt1 = source["rtt1"];
	        this.rtt2 = source["rtt2"];
	        this.rtt3 = source["rtt3"];
	        this.timeout = source["timeout"];
	        this.loss = source["loss"];
	        this.jitter = source["jitter"];
	    }
	}
	export class NetworkPath {
	    target: string;
	    hops: NetworkHop[];
	    totalRtt: number;
	    pingAvg: number;
	    pingMin: number;
	    pingMax: number;
	    pingLoss: number;
	    jitter: number;
	    // Go type: time
	    tracedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new NetworkPath(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.target = source["target"];
	        this.hops = this.convertValues(source["hops"], NetworkHop);
	        this.totalRtt = source["totalRtt"];
	        this.pingAvg = source["pingAvg"];
	        this.pingMin = source["pingMin"];
	        this.pingMax = source["pingMax"];
	        this.pingLoss = source["pingLoss"];
	        this.jitter = source["jitter"];
	        this.tracedAt = this.convertValues(source["tracedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	export class TunnelRule {
	    id: string;
	    type: string;
	    local: string;
	    remote: string;
	    bindHost?: string;
	
	    static createFrom(source: any = {}) {
	        return new TunnelRule(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.type = source["type"];
	        this.local = source["local"];
	        this.remote = source["remote"];
	        this.bindHost = source["bindHost"];
	    }
	}
	export class Profile {
	    id: string;
	    name: string;
	    group: string;
	    host: string;
	    port: number;
	    username: string;
	    authType: string;
	    password?: string;
	    privateKeyPath?: string;
	    privateKeyPassphrase?: string;
	    rememberPassword: boolean;
	    proxyJumpId?: string;
	    description: string;
	    tags: string[];
	    favorite: boolean;
	    cliEnabled: boolean;
	    cliAlias?: string;
	    aiEnabled?: boolean;
	    aiAlias?: string;
	    tunnels: TunnelRule[];
	    autoReconnect: boolean;
	    startDirectory?: string;
	    environment?: string[];
	    loginCommands?: string[];
	    // Go type: time
	    lastConnectedAt?: any;
	    // Go type: time
	    createdAt: any;
	    // Go type: time
	    updatedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new Profile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.group = source["group"];
	        this.host = source["host"];
	        this.port = source["port"];
	        this.username = source["username"];
	        this.authType = source["authType"];
	        this.password = source["password"];
	        this.privateKeyPath = source["privateKeyPath"];
	        this.privateKeyPassphrase = source["privateKeyPassphrase"];
	        this.rememberPassword = source["rememberPassword"];
	        this.proxyJumpId = source["proxyJumpId"];
	        this.description = source["description"];
	        this.tags = source["tags"];
	        this.favorite = source["favorite"];
	        this.cliEnabled = source["cliEnabled"];
	        this.cliAlias = source["cliAlias"];
	        this.aiEnabled = source["aiEnabled"];
	        this.aiAlias = source["aiAlias"];
	        this.tunnels = this.convertValues(source["tunnels"], TunnelRule);
	        this.autoReconnect = source["autoReconnect"];
	        this.startDirectory = source["startDirectory"];
	        this.environment = source["environment"];
	        this.loginCommands = source["loginCommands"];
	        this.lastConnectedAt = this.convertValues(source["lastConnectedAt"], null);
	        this.createdAt = this.convertValues(source["createdAt"], null);
	        this.updatedAt = this.convertValues(source["updatedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class Recording {
	    name: string;
	    size: number;
	    // Go type: time
	    modTime: any;
	
	    static createFrom(source: any = {}) {
	        return new Recording(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.size = source["size"];
	        this.modTime = this.convertValues(source["modTime"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class RemoteFile {
	    name: string;
	    path: string;
	    size: number;
	    isDir: boolean;
	    mode: string;
	    // Go type: time
	    modTime: any;
	    permissions: string;
	
	    static createFrom(source: any = {}) {
	        return new RemoteFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.path = source["path"];
	        this.size = source["size"];
	        this.isDir = source["isDir"];
	        this.mode = source["mode"];
	        this.modTime = this.convertValues(source["modTime"], null);
	        this.permissions = source["permissions"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ServiceInfo {
	    name: string;
	    description: string;
	    loadState: string;
	    activeState: string;
	    subState: string;
	    enabled: string;
	    cpuPercent: number;
	    memoryBytes: number;
	    resourceStats: boolean;

	    static createFrom(source: any = {}) {
	        return new ServiceInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.name = source["name"];
	        this.description = source["description"];
	        this.loadState = source["loadState"];
	        this.activeState = source["activeState"];
	        this.subState = source["subState"];
	        this.enabled = source["enabled"];
	        this.cpuPercent = source["cpuPercent"];
	        this.memoryBytes = source["memoryBytes"];
	        this.resourceStats = source["resourceStats"];
	    }
	}
	export class SessionInfo {
	    id: string;
	    profileId: string;
	    name: string;
	    state: string;
	    error?: string;
	    cols: number;
	    rows: number;
	    // Go type: time
	    startedAt: any;
	
	    static createFrom(source: any = {}) {
	        return new SessionInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.profileId = source["profileId"];
	        this.name = source["name"];
	        this.state = source["state"];
	        this.error = source["error"];
	        this.cols = source["cols"];
	        this.rows = source["rows"];
	        this.startedAt = this.convertValues(source["startedAt"], null);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	
	
	export class TunnelStatus {
	    rule: TunnelRule;
	    active: boolean;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new TunnelStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.rule = this.convertValues(source["rule"], TunnelRule);
	        this.active = source["active"];
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class WebsiteInfo {
	    backend: string;
	    mode: string;
	    name: string;
	    enabled: boolean;
	    serverNames: string[];
	    listen: string[];
	    root: string;
	
	    static createFrom(source: any = {}) {
	        return new WebsiteInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.backend = source["backend"];
	        this.mode = source["mode"];
	        this.name = source["name"];
	        this.enabled = source["enabled"];
	        this.serverNames = source["serverNames"];
	        this.listen = source["listen"];
	        this.root = source["root"];
	    }
	}
	export class WebsiteStatus {
	    backends: string[];
	    sites: WebsiteInfo[];
	    unreadable: number;

	    static createFrom(source: any = {}) {
	        return new WebsiteStatus(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.backends = source["backends"];
	        this.sites = this.convertValues(source["sites"], WebsiteInfo);
	        this.unreadable = source["unreadable"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace version {
	
	export class Release {
	    version: string;
	    url: string;
	    notes: string;
	    // Go type: time
	    publishedAt: any;
	    prerelease: boolean;
	
	    static createFrom(source: any = {}) {
	        return new Release(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.version = source["version"];
	        this.url = source["url"];
	        this.notes = source["notes"];
	        this.publishedAt = this.convertValues(source["publishedAt"], null);
	        this.prerelease = source["prerelease"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class CheckResult {
	    current: string;
	    latest?: Release;
	    updateAvailable: boolean;
	    // Go type: time
	    checkedAt: any;
	    error?: string;
	
	    static createFrom(source: any = {}) {
	        return new CheckResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.current = source["current"];
	        this.latest = this.convertValues(source["latest"], Release);
	        this.updateAvailable = source["updateAvailable"];
	        this.checkedAt = this.convertValues(source["checkedAt"], null);
	        this.error = source["error"];
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

