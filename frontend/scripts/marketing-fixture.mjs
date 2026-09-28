// Used only by the isolated marketing capture browser. No desktop backend runs.
/* global window */
export function installMarketingFixture() {
  const listeners = new Map();
  const emit = (name, data) => { for (const callback of listeners.get(name) || []) callback(data); };
  const metrics = (id) => ({ sessionId: id, online: true, cpuPercent: 18, memoryPercent: 42,
    memoryUsedMb: 1720, memoryTotalMb: 4096, diskPercent: 31, diskUsed: '12.4 GB', diskTotal: '40 GB',
    latencyMs: 48, networkRxPerSec: 182400, networkTxPerSec: 64100, loadAverage: '0.18 0.12 0.09',
    topProcesses: [{ pid: 120, command: 'nginx', memory: 2.4 }, { pid: 210, command: 'node', memory: 8.1 }] });
  let settings = {
    themeName: 'Dark', language: 'en', highlightLevel: 'basic', highlightRules: [], monitorEnabled: true, monitorIntervalSec: 5,
    connectionTimeout: 15, sidebarWidth: 280, sidebarSplitPct: 52, smartHighlight: true, restoreWorkspace: false,
    cliServerEnabled: false, updateCheckEnabled: false,
    ai: { provider: '', apiKey: '', endpoint: '', model: '' },
    sessionLog: { enabled: false, timestamps: true, maxFileMb: 10, maxSessionMb: 100 },
    terminal: { fontFamily: 'Consolas, monospace', fontSize: 15, lineHeight: 1.3, cursorStyle: 'bar', cursorBlink: false,
      themeName: 'Dark', backgroundOpacity: 1, scrollbackLines: 1000 },
  };
  const profiles = ['web-01', 'api-01', 'db-01', 'lab-01'].map((id, i) => ({
    id, name: id, group: i < 3 ? 'Demo cloud' : 'Home lab', host: `${id}.example.test`, port: 22,
    username: 'demo', authType: 'agent', rememberPassword: false, favorite: i === 0, tags: [], tunnels: [],
    cliEnabled: false, autoReconnect: false, description: 'Fictional server for a product demonstration',
    createdAt: '2026-09-28T12:00:00Z', updatedAt: '2026-09-28T12:00:00Z',
  }));
  let sessions = profiles.map((p) => ({ id: `session-${p.id}`, profileId: p.id, runtimeId: `profile:${p.id}`,
    generation: 1, name: p.name, state: 'connected', cols: 80, rows: 24 }));
  const docs = {
    '/srv/demo/README.md': '# Orbit demo stack\n\nA small, fictional deployment used to demonstrate gxShell.\n\n## Services\n\n| Service | Role | Status |\n| --- | --- | --- |\n| web | Nginx gateway | Healthy |\n| api | Application service | Healthy |\n| db | PostgreSQL | Healthy |\n\n## Deployment checklist\n\n- [x] Validate the configuration\n- [x] Check service health\n- [x] Review resource usage\n\n## Useful commands\n\n```sh\ndocker compose ps\nsystemctl status nginx --no-pager\n```\n\nAll server names and values in this demo are fictional.\n',
    '/srv/demo/compose.yaml': '# Fictional deployment — sample data only\nname: orbit-demo\n\nservices:\n  web:\n    image: nginx:stable-alpine\n    ports:\n      - "8080:80"\n    volumes:\n      - ./public:/usr/share/nginx/html:ro\n    restart: unless-stopped\n\n  api:\n    image: example/demo-api:latest\n    environment:\n      APP_ENV: demo\n      LOG_LEVEL: info\n    restart: unless-stopped\n',
    '/srv/demo/deploy.sh': '#!/bin/sh\nset -eu\n\nprintf "Validating demo stack...\\n"\ndocker compose config --quiet\ndocker compose ps\n',
    '/srv/demo/health.json': '{\n  "environment": "demo",\n  "services": {\n    "web": "healthy",\n    "api": "healthy",\n    "db": "healthy"\n  }\n}\n',
  };
  const prompt = (id) => `\x1b[38;5;79mdemo@${id.replace('session-', '')}\x1b[0m:\x1b[38;5;111m/srv/demo\x1b[0m $ `;
  const terminalBuffers = {};
  window.marketingDemo = {
    emit, docs, settings, requests: [], unknownCalls: [], approvals: [],
    seedTerminals() {
      const content = {
        'web-01': '\x1b[1;38;5;111mORBIT / WEB GATEWAY\x1b[0m\r\n\r\n$ systemctl status nginx --no-pager\r\n\x1b[38;5;79m● nginx.service - Web server\x1b[0m\r\n  Active: active (running)\r\n  Uptime: 12 days, 4 hours\r\n\r\n$ curl -I https://app.example.test\r\nHTTP/2 200\r\ncontent-type: text/html\r\n',
        'api-01': '\x1b[1;38;5;111mORBIT / APPLICATION\x1b[0m\r\n\r\n$ docker compose ps\r\nNAME         STATUS           PORTS\r\norbit-api    Up 3 days         3000/tcp\r\norbit-jobs   Up 3 days         --\r\n\r\n\x1b[38;5;79m✓ Health checks passing\x1b[0m\r\n\x1b[38;5;79m✓ Background workers ready\x1b[0m\r\n',
        'db-01': '\x1b[1;38;5;111mORBIT / DATABASE\x1b[0m\r\n\r\n$ pg_isready\r\nlocalhost:5432 - accepting connections\r\n\r\n$ df -h /\r\nFilesystem    Size  Used  Avail  Use%\r\n/dev/vda1      40G   12G    28G   31%\r\n\r\n\x1b[38;5;79m✓ Nightly backup completed\x1b[0m\r\n',
        'lab-01': '\x1b[1;38;5;111mHOME LAB / SANDBOX\x1b[0m\r\n\r\n$ uptime\r\n 14:30:00 up 8 days, 2:14\r\n load average: 0.18, 0.12, 0.09\r\n\r\n$ ls /srv/demo\r\n\x1b[38;5;111mpublic/  backups/\x1b[0m\r\nREADME.md  compose.yaml  health.json\r\n',
      };
      for (const p of profiles) {
        emit('terminal:data', { sessionId: `session-${p.id}`, data: '\x1b[2J\x1b[H' + content[p.id] + '\r\n' + prompt(`session-${p.id}`) });
        emit('monitor:update', metrics(`session-${p.id}`));
      }
    },
    requestApproval() {
      emit('cli:approval-panel', { id: 'demo-review', source: 'cli', server: 'web-01',
        summary: 'An external agent requests a service check and an optional restart on web-01.',
        items: [
          { id: 'restart', kind: 'command', text: 'systemctl restart nginx', riskTier: 'T2', riskLabel: 'Bounded change', riskLines: ['Restarts a service and may interrupt active connections.'] },
          { id: 'status', kind: 'command', text: 'systemctl status nginx --no-pager', riskTier: 'T0', riskLabel: 'Read-only' },
          { id: 'disk', kind: 'command', text: 'df -h /', riskTier: 'T0', riskLabel: 'Read-only' },
        ] });
    },
  };
  const app = {
    GetSettings: () => settings, UpdateSettings: (value) => { settings = value; return value; }, GetVersion: () => '1.8.0', GetStartupFile: () => '',
    ListProfiles: () => profiles, ListCommands: () => [], ListSessions: () => sessions, GetAppInfo: () => ({ dataDir: 'isolated-demo' }),
    GetLatestMetrics: metrics, StartMonitor: (id) => emit('monitor:update', metrics(id)),
    ListLogFiles: () => [], ListSessionLogFiles: () => [], IsRecording: () => false,
    IsTextContextMenuRegistered: () => false, IsWindowMaximised: () => false,
    ListRemoteDir: (_id, path) => ['public', 'backups', 'README.md', 'compose.yaml', 'deploy.sh', 'health.json'].map((name, i) => ({
      name, path: `${path === '/' || path === '.' ? '/srv/demo' : path}/${name}`, isDir: i < 2, size: i < 2 ? 0 : [0, 0, 760, 420, 130, 110][i],
      modTime: '2026-09-28T12:00:00Z', mode: i < 2 ? 'drwxr-xr-x' : '-rw-r--r--',
    })),
    ListTextFilesInDir: () => Object.keys(docs), ListRemoteTextFilesInDir: () => Object.keys(docs), RestoreTextFiles: (paths) => paths,
    ReadLocalFile: (path) => ({ version: 'demo-v1', content: docs[path] || '' }),
    ReadRemoteTextFile: (_id, path) => ({ version: 'demo-v1', content: docs[path] || '' }),
    WriteLocalFile: (path, content) => { docs[path] = content; return { version: 'demo-v2', conflict: false }; },
    WriteRemoteTextFile: (_id, path, content) => { docs[path] = content; return { version: 'demo-v2', conflict: false }; },
    WriteToTerminal: (id, data) => {
      for (const char of data) {
        if (char === '\r') {
          const command = terminalBuffers[id] || ''; terminalBuffers[id] = '';
          const result = command === 'docker compose ps'
            ? 'NAME         IMAGE                    STATUS\r\norbit-web    nginx:stable-alpine      Up 3 days\r\norbit-api    example/demo-api         Up 3 days\r\n'
            : command === 'pwd' ? '/srv/demo\r\n' : 'Demo command complete.\r\n';
          emit('terminal:data', { sessionId: id, data: '\r\n' + result + '\r\n' + prompt(id) });
        } else { terminalBuffers[id] = (terminalBuffers[id] || '') + char; emit('terminal:data', { sessionId: id, data: char }); }
      }
    },
    Disconnect: (id) => { sessions = sessions.filter((s) => s.id !== id); },
    RegisterApprovalPanel: () => undefined,
    SetWindowBackgroundColour: () => undefined, ResizeTerminal: () => undefined, LogCommand: () => undefined,
    ResolveCliApproval: (id, selected) => {
      window.marketingDemo.approvals.push({ id, selected });
      emit('terminal:data', { sessionId: 'session-web-01', data: '\r\n\x1b[38;5;79m[agent] Approved: 2 read-only checks\x1b[0m\r\n[agent] Service restart was not approved.\r\nnginx: active (running) | disk: 31% used\r\n\r\n' + prompt('session-web-01') });
    },
  };
  window.go = { app: { App: new Proxy(app, { get: (target, key) => (...args) => {
    window.marketingDemo.requests.push(String(key));
    if (target[key]) return Promise.resolve(target[key](...args));
    window.marketingDemo.unknownCalls.push(String(key));
    return Promise.resolve(/^List|^Read/.test(String(key)) ? [] : undefined);
  } }) } };
  window.runtime = new Proxy({ EventsOnMultiple: (name, callback) => {
    const list = listeners.get(name) || new Set(); list.add(callback); listeners.set(name, list);
    return () => list.delete(callback);
  } }, { get: (target, key) => target[key] || (() => undefined) });
}
