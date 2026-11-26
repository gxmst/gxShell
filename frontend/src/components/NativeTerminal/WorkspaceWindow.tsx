import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { CloseConnectionWindow, GetSettings, GetWindowApproval, OpenRemoteDocumentWindow, RegisterConnectionWindow, ResolveCliApproval } from "../../../wailsjs/go/app/App";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import type { types } from "../../../wailsjs/go/models";
import type { CliApprovalPanelRequest } from "../../types";
import { t } from "../../i18n";
import { normalizeAppTheme } from "../../utils/format";
import { useRenderedLinkGuard } from "../../hooks/useRenderedLinkGuard";
import { CliApprovalPanel } from "../CliApprovalPanel/CliApprovalPanel";
import { UnsavedChangesDialog } from "../modals/UnsavedChangesDialog";
import "./native-terminal.css";

const MarkdownViewer = lazy(() => import("../MarkdownViewer/MarkdownViewer"));

function ApprovalWindow({ lang, notify }: { lang: string; notify: (message: string) => void }) {
  const [request, setRequest] = useState<CliApprovalPanelRequest>();
  useEffect(() => {
    let live = true;
    void GetWindowApproval().then(value => { if (live) setRequest(value); })
      .catch(error => { if (live) notify(String(error)); });
    return () => { live = false; };
  }, [notify]);
  if (!request) return <div className="empty compact">{t(lang, "loading")}</div>;
  return <CliApprovalPanel standalone request={request} locale={lang}
    onResolve={ids => ResolveCliApproval(request.id, ids)}/>;
}

type RemoteDocument = { sessionId: string; path: string; profileId: string };

function DocumentWindow({ doc, lang, notify }: { doc: RemoteDocument; lang: string; notify: (message: string) => void }) {
  const draft = useRef<{ save: () => Promise<boolean> } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const close = useCallback(() => { void CloseConnectionWindow().catch(err => notify(String(err))); }, [notify]);
  const requestClose = useCallback(() => {
    if (draft.current) setConfirmClose(true);
    else close();
  }, [close]);

  useEffect(() => {
    const off = EventsOn("connection:close-requested", requestClose);
    void RegisterConnectionWindow().catch(error => notify(String(error)));
    return off;
  }, [notify, requestClose]);
  const blocked = useCallback(() => notify(t(lang, "linkBlocked")), [lang, notify]);
  useRenderedLinkGuard(blocked);

  return <>
    <div className="native-document-content" ref={element => { if (element) element.inert = confirmClose; }}>
      <Suspense fallback={<div className="empty compact">{t(lang, "loading")}</div>}>
        <MarkdownViewer source="remote" sessionId={doc.sessionId} remotePath={doc.path} active visible locale={lang}
          readingIdentity={JSON.stringify(["remote", doc.profileId || doc.sessionId, doc.path])}
          onDirtyChange={(dirty, save) => { draft.current = dirty ? { save } : null; }}
          onNotify={notify} onClose={requestClose} onOpenMarkdownFile={target => {
            if (target.source === "remote") void OpenRemoteDocumentWindow(target.sessionId, target.path).catch(err => notify(String(err)));
          }}/>
      </Suspense>
    </div>
    {confirmClose && <UnsavedChangesDialog title={doc.path} locale={lang} onCancel={() => setConfirmClose(false)} onDiscard={close}
      onSave={async () => {
        const saved = await draft.current?.save() ?? true;
        if (saved) close();
        else setConfirmClose(false);
        return saved;
      }}/>}
  </>;
}

export function WorkspaceWindow({ document }: { document?: RemoteDocument }) {
  const [settings, setSettings] = useState<types.AppSettings>();
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let live = true;
    const refresh = () => { void GetSettings().then(value => { if (live) setSettings(value); }).catch(err => { if (live) setNotice(String(err)); }); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { live = false; window.removeEventListener("focus", refresh); };
  }, []);
  const lang = settings?.language || "en";
  return <div className="app-shell native-workspace" data-theme={normalizeAppTheme(settings?.themeName)}>
    {document ? <DocumentWindow doc={document} lang={lang} notify={setNotice}/> : <ApprovalWindow lang={lang} notify={setNotice}/>}
    {notice && <button className="native-terminal-notice" onClick={() => setNotice("")}>{notice}</button>}
  </div>;
}
