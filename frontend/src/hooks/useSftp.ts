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

  const refreshSftp = useCallback(async (path = remotePathRef.current) => {
    const currentActive = active;
    if (!currentActive) return;
    setSftpBusy(true);
    try {
      const files = await ListRemoteDir(currentActive.id, path);
      const cacheKey = `${currentActive.id}:${path}`;
      fileCache.current[cacheKey] = files;
      setRemoteFiles(files);
      setRemotePath(path);
    } catch (err) {
      notifyRef.current?.(String(err), "error");
    } finally {
      setSftpBusy(false);
    }
  }, [active]);

  useEffect(() => {
    if (drawer === "sftp" && active) {
      const cacheKey = `${active.id}:${remotePathRef.current}`;
      const cached = fileCache.current[cacheKey];
      if (cached) {
        setRemoteFiles(cached);
      } else {
        refreshSftp(remotePathRef.current);
      }
    }
  }, [drawer, active?.id, refreshSftp]);

  return { remotePath, remoteFiles, sftpBusy, refreshSftp };
}
