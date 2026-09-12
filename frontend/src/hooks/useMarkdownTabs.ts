import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { types } from "../../wailsjs/go/models";
import {
  ListRemoteTextFilesInDir,
  ListTextFilesInDir,
  OpenRecentTextFile,
  RestoreTextFiles,
  SelectTextFile,
} from "../../wailsjs/go/app/App";
import type { Drawer, MarkdownOpenTarget, RecentMarkdownItem, Tab } from "../types";
import { isWindowsPlatform } from "../utils/clipboard";
import { usePersistedState } from "./usePersistedState";
import { t } from "../i18n";
import { documentDirectory } from "../utils/textFiles";

const normalizeLocalPath = (filePath: string) => filePath.replace(/\\/g, "/");
const localPathKey = (filePath: string) => {
  const normalized = normalizeLocalPath(filePath);
  return isWindowsPlatform() ? normalized.toLowerCase() : normalized;
};

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
  if (item.source === "local") return `local:${localPathKey(item.path)}`;
  return `remote:${item.profileId || item.sessionId || ""}:${item.path}`;
};

interface UseMarkdownTabsParams {
  tabs: Tab[];
  activeTab: string;
  profiles: types.Profile[];
  language: string;
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  setActiveTab: (id: string) => void;
  restoreActiveTab?: (id: string) => void;
  setDrawer: (drawer: Drawer) => void;
  notify: (text: string, tone?: "info" | "error" | "success") => void;
}

export interface MarkdownTabs {
  markdownSiblings: string[];
  markdownSiblingsBusy: boolean;
  markdownSiblingsError: string;
  refreshMarkdownSiblings: () => Promise<void>;
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
  restoreActiveTab,
  setDrawer,
  notify,
}: UseMarkdownTabsParams): MarkdownTabs {
  const [siblingListing, setSiblingListing] = useState({ key: "", files: [] as string[], busy: false, error: "" });
  const siblingRequest = useRef(0);
  const [recentMarkdown, setRecentMarkdown] = usePersistedState<RecentMarkdownItem[]>("gx:recentMarkdown", []);
  const workspaceFiles = useRef(readWorkspaceFiles());
  const workspaceRestoreStarted = useRef(false);
  const documentOpened = useRef(false);
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
          const normalized = localPathKey(candidate.filePath || "");
          const existing = next.find((tab) => tab.type === "markdown" && tab.filePath && localPathKey(tab.filePath) === normalized);
          if (!existing) next.push(candidate);
        }
        const activePath = localPathKey(workspaceFiles.current.activePath);
        if (activePath && !documentOpened.current) {
          const restoredActive = next.find((tab) => tab.type === "markdown" && tab.filePath && localPathKey(tab.filePath) === activePath);
          if (restoredActive) (restoreActiveTab || setActiveTab)(restoredActive.id);
        }
        return next;
      });
    }).catch((err) => {
      notify(String(err), "error");
    }).finally(() => {
      setWorkspaceRestoreReady(true);
    });
  }, [notify, setActiveTab, setTabs, restoreActiveTab]);

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
    documentOpened.current = true;
    const normalizedPath = localPathKey(filePath);
    const existing = tabsRef.current.find((tab) => tab.type === "markdown" && tab.filePath && localPathKey(tab.filePath) === normalizedPath);
    rememberMarkdown({ source: "local", path: filePath, title: fileNameFromPath(filePath) });
    if (existing) {
      setActiveTab(existing.id);
      setDrawer("documents");
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
    setDrawer("documents");
  }, [rememberMarkdown, setActiveTab, setTabs, setDrawer]);

  const openRemoteMarkdownFile = useCallback(async (sessionID: string, remotePath: string) => {
    documentOpened.current = true;
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
      setDrawer("documents");
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
    setDrawer("documents");
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

  // Folder identity includes the remote session, so an old listing can never
  // appear under another server. Moving between siblings reuses the same list.
  const activeMarkdownKey = useMemo(() => {
    const active = tabs.find(t => t.id === activeTab);
    if (active?.type !== "markdown") return "";
    if (active.markdownSource === "remote" && active.remoteSessionId && active.remotePath) {
      return JSON.stringify(["remote", active.remoteSessionId, documentDirectory(active.remotePath)]);
    }
    if (active.filePath) return JSON.stringify(["local", localPathKey(documentDirectory(active.filePath))]);
    return "";
  }, [activeTab, tabs]);

  const activeFolderRef = useRef(activeMarkdownKey);
  activeFolderRef.current = activeMarkdownKey;
  const refreshMarkdownSiblings = useCallback(async () => {
    const key = activeFolderRef.current;
    if (!key) return;
    const request = ++siblingRequest.current;
    const active = tabsRef.current.find(t => t.id === activeTabRef.current);
    setSiblingListing((current) => ({ key, files: current.key === key ? current.files : [], busy: true, error: "" }));
    try {
      const files = active?.markdownSource === "remote"
        ? await ListRemoteTextFilesInDir(active.remoteSessionId!, active.remotePath!)
        : await ListTextFilesInDir(active!.filePath!);
      if (request === siblingRequest.current && key === activeFolderRef.current) {
        setSiblingListing({ key, files: files || [], busy: false, error: "" });
      }
    } catch (err) {
      if (request === siblingRequest.current && key === activeFolderRef.current) {
        setSiblingListing({ key, files: [], busy: false, error: String(err) });
      }
    }
  }, []);

  useEffect(() => {
    void refreshMarkdownSiblings();
    return () => { siblingRequest.current += 1; };
  }, [activeMarkdownKey, refreshMarkdownSiblings]);

  const currentListing = siblingListing.key === activeMarkdownKey ? siblingListing : null;

  return {
    markdownSiblings: activeMarkdownKey ? currentListing?.files || [] : [],
    markdownSiblingsBusy: !!activeMarkdownKey && (currentListing?.busy ?? true),
    markdownSiblingsError: activeMarkdownKey ? currentListing?.error || "" : "",
    refreshMarkdownSiblings,
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
