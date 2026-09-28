import { useCallback, useEffect, useRef, useState } from "react";
import { ListRemoteDir } from "../../wailsjs/go/app/App";
import { types } from "../../wailsjs/go/models";
import type { Tab } from "../types";

type SftpView = {
  sessionId: string;
  path: string;
  files: types.RemoteFile[];
  busy: boolean;
};

const MAX_CACHE_ENTRIES = 30;
const CACHE_TTL_MS = 15_000;

function validSessionId(active?: Tab): string {
  if (!active || active.type === "markdown" || active.local || active.state !== "connected") return "";
  return active.id;
}

export function useSftp(active?: Tab, drawer?: string, notify?: (text: string, tone?: "info" | "error" | "success") => void) {
  const activeSessionId = validSessionId(active);
  const [view, setView] = useState<SftpView>({ sessionId: "", path: ".", files: [], busy: false });
  const fileCache = useRef(new Map<string, { files: types.RemoteFile[]; savedAt: number }>());
  const pending = useRef(new Map<string, Promise<types.RemoteFile[]>>());
  const sessionPaths = useRef(new Map<string, string>());
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const activeSessionRef = useRef(activeSessionId);
  const fetchSeq = useRef(0);
  const pendingPath = useRef<{ sessionId: string; path: string } | null>(null);
  const viewPathRef = useRef(".");

  // Update the identity ref during render so an old promise can never publish
  // another session's listing in the render before the reset effect runs.
  if (activeSessionRef.current !== activeSessionId) {
    activeSessionRef.current = activeSessionId;
    fetchSeq.current += 1;
  }

  const remember = useCallback((key: string, files: types.RemoteFile[]) => {
    const cache = fileCache.current;
    cache.delete(key);
    cache.set(key, { files, savedAt: Date.now() });
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest == null) break;
      cache.delete(oldest);
    }
  }, []);

  const refreshSftp = useCallback(async (requestedPath?: string, requestedSessionId?: string, preferCache = false) => {
    const sessionId = requestedSessionId || activeSessionRef.current;
    if (!sessionId) return;
    const path = requestedPath ?? viewPathRef.current;

    // A terminal link may select a different tab and request its folder in the
    // same tick. Preserve that target until the active-session reset consumes
    // it; the request below is still guarded from publishing too early.
    if (requestedSessionId && requestedSessionId !== activeSessionRef.current) {
      pendingPath.current = { sessionId, path };
    }

    const useCache = preferCache || (requestedPath !== undefined && path !== viewPathRef.current);
    const previous = fileCache.current.get(`${sessionId}:${path}`);
    if (!useCache) {
      // Explicit refreshes also follow mutations: invalidate sibling listings
      // so returning to a parent cannot resurrect a renamed/deleted entry.
      for (const key of fileCache.current.keys()) {
        if (key.startsWith(`${sessionId}:`)) fileCache.current.delete(key);
      }
      for (const key of pending.current.keys()) {
        if (key.startsWith(`${sessionId}:`)) pending.current.delete(key);
      }
    }
    const seq = ++fetchSeq.current;
    const cacheKey = `${sessionId}:${path}`;
    const cached = fileCache.current.get(cacheKey) || previous;
    const fresh = useCache && cached && Date.now() - cached.savedAt < CACHE_TTL_MS;
    sessionPaths.current.delete(sessionId);
    sessionPaths.current.set(sessionId, path);
    if (sessionPaths.current.size > MAX_CACHE_ENTRIES) sessionPaths.current.delete(sessionPaths.current.keys().next().value!);
    if (sessionId === activeSessionRef.current) {
      viewPathRef.current = path;
      setView({ sessionId, path, files: cached?.files || [], busy: !fresh });
    }

    if (fresh) return;
    let request = useCache ? pending.current.get(cacheKey) : undefined;
    if (!request) {
      request = ListRemoteDir(sessionId, path).then((files) => files || []);
      pending.current.set(cacheKey, request);
    }
    try {
      const files = await request;
      if (pending.current.get(cacheKey) === request) remember(cacheKey, files);
      if (seq !== fetchSeq.current || sessionId !== activeSessionRef.current) return;
      viewPathRef.current = path;
      setView({ sessionId, path, files, busy: false });
    } catch (err) {
      if (seq !== fetchSeq.current || sessionId !== activeSessionRef.current) return;
      setView((current) => current.sessionId === sessionId ? { ...current, busy: false } : current);
      notifyRef.current?.(String(err), "error");
    } finally {
      if (pending.current.get(cacheKey) === request) pending.current.delete(cacheKey);
    }
  }, [remember]);

  useEffect(() => {
    fetchSeq.current += 1;
    if (!activeSessionId) {
      pendingPath.current = null;
      viewPathRef.current = ".";
      setView({ sessionId: "", path: ".", files: [], busy: false });
      return;
    }

    // Restore each server's last directory before the drawer effect runs.
    {
      const pending = pendingPath.current?.sessionId === activeSessionId ? pendingPath.current : null;
      pendingPath.current = null;
      // If an explicit terminal-link request already published its target in
      // this commit, preserve it instead of resetting that just-requested path.
      const path = pending?.path || sessionPaths.current.get(activeSessionId) || ".";
      viewPathRef.current = path;
      setView({ sessionId: activeSessionId, path, files: fileCache.current.get(`${activeSessionId}:${path}`)?.files || [], busy: false });
    }
  }, [activeSessionId]);

  useEffect(() => {
    if (drawer === "sftp" && activeSessionId) {
      void refreshSftp(viewPathRef.current, activeSessionId, true);
    }
  }, [drawer, activeSessionId, refreshSftp]);

  // Derive a blank view immediately on identity changes. This prevents even a
  // single render of server A's files under server B's title.
  const isolated = view.sessionId === activeSessionId
    ? view
    : { sessionId: activeSessionId, path: ".", files: [], busy: false };

  return {
    remotePath: isolated.path,
    remoteFiles: isolated.files,
    sftpBusy: isolated.busy,
    refreshSftp,
  };
}
