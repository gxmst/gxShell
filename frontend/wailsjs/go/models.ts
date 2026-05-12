export namespace types {
	
	export class TerminalSettings {
	    fontFamily: string;
	    fontSize: number;
	    lineHeight: number;
	    cursorStyle: string;
	    cursorBlink: boolean;
	    themeName: string;
	    backgroundOpacity: number;
	    scrollbackLines: number;
	
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
	    savePasswords: boolean;
	    smartHighlight: boolean;
	    confirmOnDisconnect: boolean;
	
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
	        this.savePasswords = source["savePasswords"];
	        this.smartHighlight = source["smartHighlight"];
	        this.confirmOnDisconnect = source["confirmOnDisconnect"];
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
	    description: string;
	    tags: string[];
	    favorite: boolean;
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
	        this.description = source["description"];
	        this.tags = source["tags"];
	        this.favorite = source["favorite"];
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

}

