import { useCallback, useEffect, useRef, useState } from "react";
import type { types } from "../../wailsjs/go/models";
import { RestoreTextFiles } from "../../wailsjs/go/app/App";
import type { SplitPane } from "../types";
import type { useSessions } from "./useSessions";
import { needsSecret } from "../utils/format";
import { sameTerminal, terminalKey } from "../utils/sessionIdentity";
import { applyWorkspace, captureWorkspace, parseWorkspaces, WORKSPACES_KEY, workspacePathKey, type NamedWorkspace } from "../utils/workspaces";
import { applyBackupWorkspaces } from "../utils/backupWorkspaces";
import { t, type LangKey } from "../i18n";

type SecretPrompt = { profile: types.Profile; submit: (password: string, passphrase: string) => Promise<void>; cancel: () => void };

export function useNamedWorkspaces(options: { sessions: ReturnType<typeof useSessions>; profiles: types.Profile[]; floating: string[]; split: SplitPane | null; setSplit: (split: SplitPane | null) => void; dock: (ids: string[]) => void; language: string }) {
  const [initial] = useState(() => { try { return { items: parseWorkspaces(localStorage.getItem(WORKSPACES_KEY), options.language || "en"), error: "" }; } catch (err) { return { items: [], error: String(err) }; } });
  const [workspaces, setWorkspaces] = useState<NamedWorkspace[]>(initial.items);
  const saved = useRef(workspaces);
  const current = useRef(options);
  current.current = options;
  // Workspace operations report both notices and thrown errors to the user, so
  // every message below has to follow the language setting. `tr` reads the ref
  // rather than closing over `options`, which keeps its identity stable — the
  // callbacks that use it are declared with `[]` or `[persist]` deps.
  const tr = useCallback((key: LangKey, params?: Record<string, string>) => t(current.current.language || "en", key, params), []);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [secretPrompt, setSecretPrompt] = useState<SecretPrompt | null>(null);
  const [pending, setPending] = useState<{ workspace: NamedWorkspace; connected: Map<string, string>; granted: string[]; revision: number; token: number } | null>(null);
  const pendingSecret = useRef<((id: string | null) => void) | null>(null);
  const operation = useRef(0);
  const running = useRef(false);
  const importing = useRef(false);
  useEffect(() => () => { operation.current++; pendingSecret.current?.(null); }, []);
  useEffect(() => {
    if (!pending || pending.token !== operation.current) return;
    const o = current.current;
    const tabs = o.sessions.tabs;
    const result = applyWorkspace(pending.workspace, tabs, pending.connected, pending.granted);
    if (o.sessions.isFocusRequestCurrent(pending.revision)) {
      o.sessions.setTabs(result.tabs);
      o.setSplit(result.split);
      o.dock(result.ids);
      if (result.active) o.sessions.finishFocusRequest(result.active, pending.revision);
    } else {
      o.sessions.setTabs([...tabs, ...result.tabs.filter((tab) => !tabs.some((old) => old.id === tab.id))]);
    }
    setPending(null);
  }, [pending]);

  const persist = useCallback((next: NamedWorkspace[]) => {
    if (importing.current) throw new Error(tr("workspacesImportInProgress"));
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify(next));
    saved.current = next;
    setWorkspaces(next);
  }, [tr]);
  const restoreBackup = useCallback(async (previous: string | null, next: string, apply: () => Promise<void>) => {
    if (running.current || importing.current) throw new Error(tr("workspacesBusy"));
    importing.current = true;
    setBusy(true);
    try {
      const parsed = await applyBackupWorkspaces(previous, next, apply, current.current.language || "en");
      saved.current = parsed;
      setWorkspaces(parsed);
    } finally {
      importing.current = false;
      setBusy(false);
    }
  }, [tr]);
  const snapshot = useCallback((name: string, id?: string) => {
    const o = current.current;
    if (!id && saved.current.length >= 30) throw new Error(tr("workspacesLimit", { count: "30" }));
    if (saved.current.some((w) => w.id !== id && w.name.toLowerCase() === name.trim().toLowerCase())) throw new Error(tr("workspacesNameExists"));
    const captured = captureWorkspace(name, o.sessions.tabs.filter((tab) => !o.floating.includes(tab.id)), o.profiles, o.sessions.activeTab, o.split, o.language || "en");
    if (id) captured.id = id;
    persist([...saved.current.filter((w) => w.id !== id), captured]);
  }, [persist, tr]);
  const rename = useCallback((id: string, name: string) => {
    if (!name.trim() || name.trim().length > 64) throw new Error(tr("workspacesNameLength"));
    if (saved.current.some((w) => w.id !== id && w.name.toLowerCase() === name.trim().toLowerCase())) throw new Error(tr("workspacesNameExists"));
    persist(saved.current.map((w) => w.id === id ? { ...w, name: name.trim(), updatedAt: Date.now() } : w));
  }, [persist, tr]);
  const remove = useCallback((id: string) => persist(saved.current.filter((w) => w.id !== id)), [persist]);

  const cancel = useCallback(() => {
    operation.current++;
    pendingSecret.current?.(null);
    pendingSecret.current = null;
    setSecretPrompt(null);
  }, []);

  const open = useCallback(async (workspace: NamedWorkspace): Promise<string[] | null> => {
    // A skipped reentrant call is not a successfully completed restoration.
    if (running.current || importing.current) return null;
    running.current = true;
    const token = ++operation.current;
    const revision = current.current.sessions.beginFocusRequest();
    const issues: string[] = [];
    const connected = new Map<string, string>();
    let granted: string[] = [];
    setBusy(true);
    try {
      const paths = workspace.items.filter((i) => i.kind === "file").map((i) => i.target);
      if (paths.length) {
        try { granted = await RestoreTextFiles(paths) || []; } catch (err) { issues.push(String(err)); }
        for (const path of paths) {
          if (!granted.some((p) => workspacePathKey(p) === workspacePathKey(path)) && !current.current.sessions.tabs.some((t) => t.filePath && workspacePathKey(t.filePath) === workspacePathKey(path))) issues.push(`${path}: ${tr("workspacesFileUnavailable")}`);
        }
      }
      for (const item of workspace.items.filter((i) => i.kind === "profile")) {
        if (token !== operation.current) break;
        const profile = current.current.profiles.find((p) => p.id === item.target);
        if (!profile) { issues.push(`${item.title}: ${tr("workspacesProfileMissing")}`); continue; }
        setProgress(profile.name || profile.host);
        try {
          const existing = current.current.sessions.tabs.find((t) => t.type !== "markdown" && sameTerminal(t, profile.id, item.instanceId) && ["connected", "connecting", "restoring", "reconnecting"].includes(t.state));
          let id: string | null;
          if (existing) id = existing.id;
          else if (needsSecret(profile)) {
            id = await new Promise<string | null>((resolve) => {
              pendingSecret.current = resolve;
              setSecretPrompt({ profile, cancel: () => { setSecretPrompt(null); pendingSecret.current = null; resolve(null); }, submit: async (password, passphrase) => {
                const id = await current.current.sessions.connectWorkspaceProfile(profile, password, passphrase, item.instanceId);
                setSecretPrompt(null); pendingSecret.current = null; resolve(id);
              } });
            });
          } else id = await current.current.sessions.connectWorkspaceProfile(profile, "", "", item.instanceId);
          if (id) connected.set(terminalKey(profile.id, item.instanceId), id);
          else issues.push(`${item.title}: ${tr("workspacesAuthSkipped")}`);
        } catch (err) { issues.push(`${item.title}: ${String(err)}`); }
      }
      if (token !== operation.current) return issues;
      setPending({ workspace, connected, granted, revision, token });
      return issues;
    } finally {
      running.current = false;
      setBusy(false); setProgress("");
    }
  }, [tr]);

  return { workspaces, snapshot, rename, remove, restoreBackup, open, cancel, busy, progress, secretPrompt, storageError: initial.error };
}
