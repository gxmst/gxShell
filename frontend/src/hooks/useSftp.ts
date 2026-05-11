import { useCallback, useEffect, useState } from "react";
import { ListRemoteDir } from "../../wailsjs/go/main/App";
import { types } from "../../wailsjs/go/models";
import type { Tab } from "../types";

export function useSftp(active?: Tab, drawer?: string, notify?: (text: string, tone?: "info" | "error" | "success") => void) {
  const [remotePath, setRemotePath] = useState(".");
  const [remoteFiles, setRemoteFiles] = useState<types.RemoteFile[]>([]);
  const [sftpBusy, setSftpBusy] = useState(false);

  const refreshSftp = useCallback(async (path = remotePath) => {
    if (!active) return;
    setSftpBusy(true);
    try {
      setRemoteFiles(await ListRemoteDir(active.id, path));
      setRemotePath(path);
    } catch (err) {
      notify?.(String(err), "error");
    } finally {
      setSftpBusy(false);
    }
  }, [active, remotePath, notify]);

  useEffect(() => {
    if (drawer === "sftp" && active) refreshSftp(remotePath);
  }, [drawer, active?.id]);

  return { remotePath, remoteFiles, sftpBusy, refreshSftp };
}

