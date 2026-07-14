import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { types } from "../../wailsjs/go/models";
import {
  ListRemoteTextFilesInDir,
  ListTextFilesInDir,
  OpenRecentTextFile,
  RestoreTextFiles,
  SelectTextFile,
} from "../../wailsjs/go/main/App";
import type { Drawer, MarkdownOpenTarget, RecentMarkdownItem, Tab } from "../types";
import { usePersistedState } from "./usePersistedState";
import { t } from "../i18n";

const normalizeLocalPath = (filePath: string) => filePath.replace(/\\/g, "/");

const newMarkdownTabId = () => `text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const fileNameFromPath = (filePath: string) => filePath.split(/[\\/]/).pop() || "Text file";

const readWorkspaceFiles = (): { paths: string[]; activePath: string } => {
  try {
    const parsed = JSON.parse(localStorage.getItem("gx:workspaceLocalFiles") || "[]");
    const paths = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, 30) : [];
    return { paths, activePath: localStorage.getItem("gx:workspaceActiveLocalFile") || "" };
  } catch {
    return { paths: [], activePath: "" };
  }
};

const recentMarkdownId = (item: Pick<RecentMarkdownItem, "source" | "path" | "profileId" | "sessionId">) => {
  if (item.source === "local") return `local:${normalizeLocalPath(item.path).toLowerCase()}`;
  return `remote:${item.profileId || item.sessionId || ""}:${item.path}`;
};

interface UseMarkdownTabsParams {
  tabs: Tab[];
  activeTab: string;
  profiles: types.Profile[];
  language: string;
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  setActiveTab: (id: string) => void;
  setDrawer: (drawer: Drawer) => void;
  notify: (text: string, tone?: "info" | "error" | "success") => void;
}

export interface MarkdownTabs {
  markdownSiblings: string[];
  recentMarkdown: RecentMarkdownItem[];
  openMarkdownFile: (filePath: string) => Promise<void>;
  openRemoteMarkdownFile: (sessionID: string, remotePath: string) => Promise<void>;
  openMarkdownTarget: (target: MarkdownOpenTarget) => void;
  handleOpenMarkdown: () => Promise<void>;
  handleOpenRecentMarkdown: (item: RecentMarkdownItem) => Promise<void>;
  handleRemoveRecentMarkdown: (id: string) => void;
  handleOpenMarkdownSibling: (path: string) => void;
}

// useMarkdownTabs owns the markdown/text-file tab surface that used to live
// inline in App: opening local and remote files (with de-duplication against
// existing tabs), the recent-files list, and the sibling list shown in the
// Files drawer. It keeps its own ref mirror of the current tabs so its
// callbacks read the latest tabs without being re-created on every tab change.
export function useMarkdownTabs({
  tabs,
  activeTab,
  profiles,
  language,
  setTabs,
  setActiveTab,
  setDrawer,
  notify,
}: UseMarkdownTabsParams): MarkdownTabs {
  const [markdownSiblings, setMarkdownSiblings] = useState<string[]>([]);
  const [recentMarkdown, setRecentMarkdown] = usePersistedState<RecentMarkdownItem[]>("gx:recentMarkdown", []);
  const workspaceFiles = useRef(readWorkspaceFiles());
  const workspaceRestoreStarted = useRef(false);
  const [workspaceRestoreReady, setWorkspaceRestoreReady] = useState(workspaceFiles.current.paths.length === 0);

  // Mirror the live tabs/activeTab in refs so callbacks can read the current
  // value without listing tabs as a dependency (which would rebuild every
  // callback on each keystroke of terminal output that touches a tab).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;

  useEffect(() => {
    if (workspaceRestoreStarted.current || workspaceFiles.current.paths.length === 0) return;
    workspaceRestoreStarted.current = true;
    RestoreTextFiles(workspaceFiles.current.paths).then((restored) => {
      if (!restored?.length) return;
      const candidates: Tab[] = restored.map((filePath) => ({
        id: newMarkdownTabId(),
        profileId: "",
        title: fileNameFromPath(filePath),
        state: "connected",
        type: "markdown",
        markdownSource: "local",
        filePath,
      }));
      setTabs((current) => {
        const next = [...current];
        for (const candidate of candidates) {
          const normalized = normalizeLocalPath(candidate.filePath || "");
          const existing = next.find((tab) => tab.type === "markdown" && tab.filePath && normalizeLocalPath(tab.filePath) === normalized);
          if (!existing) next.push(candidate);
        }
        const activePath = normalizeLocalPath(workspaceFiles.current.activePath);
        if (activePath) {
          const restoredActive = next.find((tab) => tab.type === "markdown" && tab.filePath && normalizeLocalPath(tab.filePath) === activePath);
          if (restoredActive) setActiveTab(restoredActive.id);
        }
        return next;
      });
    }).catch((err) => {
      notify(String(err), "error");
    }).finally(() => {
      setWorkspaceRestoreReady(true);
    });
  }, [notify, setActiveTab, setTabs]);

  useEffect(() => {
    if (!workspaceRestoreReady) return;
    const localTabs = tabs.filter((tab) => tab.type === "markdown" && tab.markdownSource !== "remote" && tab.filePath);
    const paths = localTabs.map((tab) => tab.filePath as string);
    const active = localTabs.find((tab) => tab.id === activeTab);
    try {
      localStorage.setItem("gx:workspaceLocalFiles", JSON.stringify(paths));
      localStorage.setItem("gx:workspaceActiveLocalFile", active?.filePath || "");
    } catch {}
  }, [activeTab, tabs, workspaceRestoreReady]);

  const rememberMarkdown = useCallback((item: Omit<RecentMarkdownItem, "id" | "openedAt">) => {
    const nextItem: RecentMarkdownItem = {
      ...item,
      id: recentMarkdownId(item),
      openedAt: Date.now(),
    };
    setRecentMarkdown((prev) => [nextItem, ...prev.filter((old) => old.id !== nextItem.id)].slice(0, 30));
  }, [setRecentMarkdown]);

  const openMarkdownFile = useCallback(async (filePath: string) => {
    const normalizedPath = normalizeLocalPath(filePath);
    const existing = tabsRef.current.find((tab) => tab.type === "markdown" && tab.filePath && normalizeLocalPath(tab.filePath) === normalizedPath);
    rememberMarkdown({ source: "local", path: filePath, title: fileNameFromPath(filePath) });
    if (existing) {
      setActiveTab(existing.id);
      setDrawer("sftp");
      try {
        const siblings = await ListTextFilesInDir(filePath);
        setMarkdownSiblings(siblings || []);
      } catch {
        setMarkdownSiblings([]);
      }
      return;
    }

    const fileName = fileNameFromPath(filePath);
    const newTab: Tab = {
      id: newMarkdownTabId(),
      profileId: "",
      title: fileName,
      state: "connected",
      type: "markdown",
      markdownSource: "local",
      filePath: filePath
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTab(newTab.id);
    setDrawer("sftp");

    try {
      const siblings = await ListTextFilesInDir(filePath);
      setMarkdownSiblings(siblings || []);
    } catch {
      setMarkdownSiblings([]);
    }
  }, [rememberMarkdown, setActiveTab, setTabs, setDrawer]);

  const openRemoteMarkdownFile = useCallback(async (sessionID: string, remotePath: string) => {
    const sessionTab = tabsRef.current.find((tab) => tab.id === sessionID);
    const profile = sessionTab ? profilesRef.current.find((item) => item.id === sessionTab.profileId) : undefined;
    const existing = tabsRef.current.find((tab) => (
      tab.type === "markdown" &&
      tab.markdownSource === "remote" &&
      tab.remoteSessionId === sessionID &&
      tab.remotePath === remotePath
    ));
    rememberMarkdown({
      source: "remote",
      path: remotePath,
      title: fileNameFromPath(remotePath),
      sessionId: sessionID,
      profileId: sessionTab?.profileId,
      host: profile ? `${profile.username}@${profile.host}` : sessionTab?.title,
    });
    if (existing) {
      setActiveTab(existing.id);
      setDrawer("sftp");
      try {
        const siblings = await ListRemoteTextFilesInDir(sessionID, remotePath);
        setMarkdownSiblings(siblings || []);
      } catch {
        setMarkdownSiblings([]);
      }
      return;
    }

    const newTab: Tab = {
      id: newMarkdownTabId(),
      profileId: sessionTab?.profileId || "",
      title: fileNameFromPath(remotePath),
      state: "connected",
      type: "markdown",
      markdownSource: "remote",
      remotePath,
      remoteSessionId: sessionID,
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTab(newTab.id);
    setDrawer("sftp");

    try {
      const siblings = await ListRemoteTextFilesInDir(sessionID, remotePath);
      setMarkdownSiblings(siblings || []);
    } catch {
      setMarkdownSiblings([]);
    }
  }, [rememberMarkdown, setActiveTab, setTabs, setDrawer]);

  const openMarkdownTarget = useCallback((target: MarkdownOpenTarget) => {
    if (target.source === "remote") {
      openRemoteMarkdownFile(target.sessionId, target.path);
    } else {
      openMarkdownFile(target.path);
    }
  }, [openMarkdownFile, openRemoteMarkdownFile]);

  const handleOpenMarkdown = useCallback(async () => {
    try {
      const filePath = await SelectTextFile();
      if (filePath) {
        openMarkdownFile(filePath);
      }
    } catch (err) {
      notify(String(err), "error");
    }
  }, [openMarkdownFile, notify]);

  const handleOpenRecentMarkdown = useCallback(async (item: RecentMarkdownItem) => {
    try {
      if (item.source === "local") {
        const allowed = await OpenRecentTextFile(item.path);
        if (allowed) openMarkdownFile(allowed);
        return;
      }

      const liveSession = tabsRef.current.find((tab) => (
        tab.type !== "markdown" &&
        (tab.id === item.sessionId || (!!item.profileId && tab.profileId === item.profileId)) &&
        tab.state === "connected"
      ));
      if (!liveSession) {
        notify(t(language, "connectServerFirstTextFile"), "info");
        return;
      }
      openRemoteMarkdownFile(liveSession.id, item.path);
    } catch (err) {
      notify(String(err), "error");
    }
  }, [notify, openMarkdownFile, openRemoteMarkdownFile, language]);

  const handleRemoveRecentMarkdown = useCallback((id: string) => {
    setRecentMarkdown((prev) => prev.filter((item) => item.id !== id));
  }, [setRecentMarkdown]);

  const handleOpenMarkdownSibling = useCallback((path: string) => {
    const active = tabsRef.current.find((tab) => tab.id === activeTabRef.current);
    if (active?.type === "markdown" && active.markdownSource === "remote" && active.remoteSessionId) {
      openRemoteMarkdownFile(active.remoteSessionId, path);
      return;
    }
    openMarkdownFile(path);
  }, [openMarkdownFile, openRemoteMarkdownFile]);

  // Refresh the sibling list whenever the active markdown tab changes.
  useEffect(() => {
    const active = tabs.find(t => t.id === activeTab);
    if (active?.type === 'markdown' && active.markdownSource === "remote" && active.remoteSessionId && active.remotePath) {
      ListRemoteTextFilesInDir(active.remoteSessionId, active.remotePath).then(siblings => {
        setMarkdownSiblings(siblings || []);
      }).catch(() => {
        setMarkdownSiblings([]);
      });
    } else if (active?.type === 'markdown' && active.filePath) {
      ListTextFilesInDir(active.filePath).then(siblings => {
        setMarkdownSiblings(siblings || []);
      }).catch(() => {
        setMarkdownSiblings([]);
      });
    } else {
      setMarkdownSiblings([]);
    }
  }, [activeTab, tabs]);

  return {
    markdownSiblings,
    recentMarkdown,
    openMarkdownFile,
    openRemoteMarkdownFile,
    openMarkdownTarget,
    handleOpenMarkdown,
    handleOpenRecentMarkdown,
    handleRemoveRecentMarkdown,
    handleOpenMarkdownSibling,
  };
}
