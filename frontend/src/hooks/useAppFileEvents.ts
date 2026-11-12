import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { GetStartupFile } from "../../wailsjs/go/app/App";
import { EventsOn, OnFileDrop, OnFileDropOff } from "../../wailsjs/runtime/runtime";
import type { Drawer, Tab } from "../types";
import type { KiRequest } from "../components/modals/KeyboardInteractiveDialog";
import type { useMarkdownTabs } from "./useMarkdownTabs";
import type { useSessions } from "./useSessions";
import type { useToasts } from "./useToasts";
import { isSupportedDocumentPath } from "../utils/textFiles";
import { emptyProfile } from "../constants";
import { t } from "../i18n";

type FileEventsOptions = {
  openMarkdownFile: ReturnType<typeof useMarkdownTabs>["openMarkdownFile"];
  handleOpenMarkdown: ReturnType<typeof useMarkdownTabs>["handleOpenMarkdown"];
  setDrawer: Dispatch<SetStateAction<Drawer>>;
  setProfileModal: Dispatch<SetStateAction<import("../../wailsjs/go/models").types.Profile | null>>;
  notify: ReturnType<typeof useToasts>["notify"];
  sessionIsCurrentRuntimeEvent: ReturnType<typeof useSessions>["isCurrentRuntimeEvent"];
  sessionTabs: Tab[];
  language: string;
};

export function useAppFileEvents({
  openMarkdownFile, handleOpenMarkdown, setDrawer, setProfileModal, notify,
  sessionIsCurrentRuntimeEvent, sessionTabs, language,
}: FileEventsOptions) {
  const [kiRequests, setKiRequests] = useState<KiRequest[]>([]);
  const langRef = useRef(language);
  langRef.current = language;

  useEffect(() => {
    OnFileDrop((_x, _y, _paths) => {
      // The browser-side callback only installs Wails' drop listener. The
      // trusted open path is handled in Go, where dropped paths are confirmed
      // with a native dialog before they are added to the local-file allowlist.
    }, false);

    const unsubFileOpen = EventsOn("file:open", (filePath: string) => {
      if (isSupportedDocumentPath(filePath)) {
        openMarkdownFile(filePath);
      }
    });

    // Explorer's context-menu/Open With path is distinct from drag-and-drop.
    const openExternalDocument = (filePath: string) => {
      if (!isSupportedDocumentPath(filePath)) return;
      openMarkdownFile(filePath);
    };
    const unsubExternalFileOpen = EventsOn("file:open-external", openExternalDocument);

    const unsubRecordingError = EventsOn("recording:error", (payload: { error?: string }) => {
      notify(payload?.error || "Failed to finalize recording", "error");
    });
    const unsubSessionLogError = EventsOn("session-log:error", (payload: { error?: string }) => {
      notify(t(langRef.current, "sessionLoggingStopped", { error: payload?.error || t(langRef.current, "unknownError") }), "error");
    });

    // Surface local CLI HTTP server startup failures (e.g. port already in
    // use); otherwise the external gxshell-cli silently cannot connect.
    const unsubCliServerError = EventsOn("cli:server-error", (payload: { address?: string; error?: string }) => {
      notify(t(langRef.current, "cliServerError", { error: payload?.error || "unknown error" }), "error");
    });

    // Keyboard-interactive (2FA/OTP/PAM) prompts raised mid-handshake. The Go
    // side blocks the SSH handshake until AnswerKeyboardInteractive resolves the
    // matching requestId; the :closed event fires if the handshake gives up
    // (timeout) so we can dismiss a dialog the user never answered.
    const unsubKi = EventsOn("terminal:keyboard-interactive", (payload: KiRequest) => {
      if (!sessionIsCurrentRuntimeEvent(payload)) return;
      setKiRequests((prev) => prev.some((item) => item.requestId === payload.requestId) ? prev : [...prev, payload]);
    });
    const unsubKiClosed = EventsOn("terminal:keyboard-interactive:closed", (payload: Pick<KiRequest, "requestId" | "runtimeId" | "generation">) => {
      setKiRequests((prev) => prev.filter((item) => {
        if (item.requestId !== payload.requestId) return true;
        if (payload.runtimeId && item.runtimeId !== payload.runtimeId) return true;
        if (payload.generation && item.generation !== payload.generation) return true;
        return false;
      }));
    });

    // Pull side of the file-open handshake. On first launch the Go side may emit
    // "file:open" during OnDomReady, before this listener exists, so the pushed
    // event is lost and the app opens without the document. Pulling once here,
    // right after the listener is registered, recovers that file. Both paths are
    // idempotent because openMarkdownFile de-duplicates by tab.
    GetStartupFile().then((filePath) => {
      if (filePath) openExternalDocument(filePath);
    }).catch(() => undefined);

    // 托盘菜单事件监听
    const unsubTrayNewConnection = EventsOn("tray:new-connection", () => {
      setProfileModal(emptyProfile());
    });

    const unsubTrayOpenMarkdown = EventsOn("tray:open-markdown", () => {
      handleOpenMarkdown();
    });

    const unsubTraySettings = EventsOn("tray:settings", () => {
      setDrawer("settings");
    });

    return () => {
      if (unsubFileOpen) unsubFileOpen();
      if (unsubExternalFileOpen) unsubExternalFileOpen();
      if (unsubRecordingError) unsubRecordingError();
      unsubSessionLogError?.();
      if (unsubCliServerError) unsubCliServerError();
      if (unsubTrayNewConnection) unsubTrayNewConnection();
      if (unsubTrayOpenMarkdown) unsubTrayOpenMarkdown();
      if (unsubTraySettings) unsubTraySettings();
      if (unsubKi) unsubKi();
      if (unsubKiClosed) unsubKiClosed();
      OnFileDropOff();
    };
  }, [openMarkdownFile, handleOpenMarkdown, setDrawer, setProfileModal, notify, sessionIsCurrentRuntimeEvent]);

  // A prompt can be queued while its connection is current and become stale
  // when a reconnect advances the runtime generation before the timeout event
  // arrives. Re-check the queue whenever session state changes.
  useEffect(() => {
    setKiRequests((prev) => {
      const next = prev.filter((request) => sessionIsCurrentRuntimeEvent(request));
      return next.length === prev.length ? prev : next;
    });
  }, [sessionIsCurrentRuntimeEvent, sessionTabs]);

  return { kiRequests, setKiRequests };
}
