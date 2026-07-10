import { useCallback, useEffect, useState, useRef } from "react";
import { ListRemoteDir } from "../../wailsjs/go/main/App";
import { types } from "../../wailsjs/go/models";
import type { Tab } from "../types";

export function useSftp(active?: Tab, drawer?: string, notify?: (text: string, tone?: "info" | "error" | "success") => void) {
  const [remotePath, setRemotePath] = useState(".");
  const [remoteFiles, setRemoteFiles] = useState<types.RemoteFile[]>([]);
  const [sftpBusy, setSftpBusy] = useState(false);
  const fileCache = useRef<Record<string, types.RemoteFile[]>>({});
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const remotePathRef = useRef(remotePath);
  remotePathRef.current = remotePath;
  const fetchSeq = useRef(0);

  const refreshSftp = useCallback(async (path = remotePathRef.current, sessionId = active?.id) => {
    if (!sessionId) return;
    if (sessionId === active?.id && (active.type === "markdown" || active.local || active.state !== "connected")) return;
    const seq = ++fetchSeq.current;
    setSftpBusy(true);
    try {
      const files = await ListRemoteDir(sessionId, path);
      if (seq !== fetchSeq.current) return;
      const cacheKey = `${sessionId}:${path}`;
      fileCache.current[cacheKey] = files;
      setRemoteFiles(files);
      setRemotePath(path);
    } catch (err) {
      if (seq !== fetchSeq.current) return;
      notifyRef.current?.(String(err), "error");
    } finally {
      if (seq === fetchSeq.current) setSftpBusy(false);
    }
  }, [active?.id, active?.type, active?.local, active?.state]);

  useEffect(() => {
    if (drawer === "sftp" && active && active.type !== "markdown" && !active.local && active.state === "connected") {
      const cacheKey = `${active.id}:${remotePathRef.current}`;
      const cached = fileCache.current[cacheKey];
      if (cached) {
        setRemoteFiles(cached);
      } else {
        refreshSftp(remotePathRef.current);
      }
    }
  }, [drawer, active?.id, active?.local, active?.state, refreshSftp]);

  return { remotePath, remoteFiles, sftpBusy, refreshSftp };
}
