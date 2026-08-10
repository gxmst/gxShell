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

function validSessionId(active?: Tab): string {
  if (!active || active.type === "markdown" || active.local || active.state !== "connected") return "";
  return active.id;
}

export function useSftp(active?: Tab, drawer?: string, notify?: (text: string, tone?: "info" | "error" | "success") => void) {
  const activeSessionId = validSessionId(active);
  const [view, setView] = useState<SftpView>({ sessionId: "", path: ".", files: [], busy: false });
  const fileCache = useRef(new Map<string, types.RemoteFile[]>());
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
    cache.set(key, files);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest == null) break;
      cache.delete(oldest);
    }
  }, []);

  const refreshSftp = useCallback(async (requestedPath?: string, requestedSessionId?: string) => {
    const sessionId = requestedSessionId || activeSessionRef.current;
    if (!sessionId) return;
    const path = requestedPath ?? viewPathRef.current;

    // A terminal link may select a different tab and request its folder in the
    // same tick. Preserve that target until the active-session reset consumes
    // it; the request below is still guarded from publishing too early.
    if (requestedSessionId && requestedSessionId !== activeSessionRef.current) {
      pendingPath.current = { sessionId, path };
    }

    const seq = ++fetchSeq.current;
    const cacheKey = `${sessionId}:${path}`;
    const cached = fileCache.current.get(cacheKey);
    if (sessionId === activeSessionRef.current) {
      viewPathRef.current = path;
      setView({ sessionId, path, files: cached || [], busy: true });
    }

    try {
      const files = (await ListRemoteDir(sessionId, path)) || [];
      if (seq !== fetchSeq.current || sessionId !== activeSessionRef.current) return;
      remember(cacheKey, files);
      viewPathRef.current = path;
      setView({ sessionId, path, files, busy: false });
    } catch (err) {
      if (seq !== fetchSeq.current || sessionId !== activeSessionRef.current) return;
      setView((current) => current.sessionId === sessionId ? { ...current, busy: false } : current);
      notifyRef.current?.(String(err), "error");
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

    // Clear first; a separate drawer effect will load only this session.
    setView((current) => {
      const pending = pendingPath.current?.sessionId === activeSessionId ? pendingPath.current : null;
      pendingPath.current = null;
      // If an explicit terminal-link request already published its target in
      // this commit, preserve it instead of resetting that just-requested path.
      const path = pending?.path || (current.sessionId === activeSessionId ? current.path : ".");
      viewPathRef.current = path;
      return { sessionId: activeSessionId, path, files: [], busy: false };
    });
  }, [activeSessionId]);

  useEffect(() => {
    if (drawer === "sftp" && activeSessionId) {
      void refreshSftp(viewPathRef.current, activeSessionId);
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
