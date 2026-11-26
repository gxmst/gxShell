import { lazy, useCallback, useEffect, useRef, useState } from "react";
import { AnswerKeyboardInteractive, CloseConnectionWindow, DeleteProfile, DuplicateProfile, GetSettings, ListProfiles,
  SaveConnectionProfile, SelectPrivateKey, SubmitQuickConnection, TestProfileConnection, UpdateProfilesBatch } from "../../../wailsjs/go/app/App";
import { types } from "../../../wailsjs/go/models";
import { EventsOn } from "../../../wailsjs/runtime/runtime";
import { emptyProfile } from "../../constants";
import { t } from "../../i18n";
import { normalizeAppTheme } from "../../utils/format";
import { ConfirmDialog } from "../modals/ConfirmDialog";
import { KeyboardInteractiveDialog, type KiRequest } from "../modals/KeyboardInteractiveDialog";
import "./connection-window.css";

const ProfileModal = lazy(() => import("../modals/ProfileModal").then(m => ({ default: m.ProfileModal })));

const QuickConnectModal = lazy(() => import("../modals/QuickConnectModal").then(m => ({ default: m.QuickConnectModal })));

const BulkProfilesModal = lazy(() => import("../modals/BulkProfilesModal").then(m => ({ default: m.BulkProfilesModal })));

export type ConnectionForm = "new" | "edit" | "quick" | "bulk";

export function ConnectionWindow({ kind, id }: { kind: ConnectionForm; id: string }) {
  const [settings, setSettings] = useState<types.AppSettings>();
  const [profiles, setProfiles] = useState<types.Profile[]>([]);
  const [initial, setInitial] = useState<types.Profile>();
  const [notice, setNotice] = useState("");
  const [challenge, setChallenge] = useState<KiRequest>();
  const [deleting, setDeleting] = useState(false);
  const [loadError, setLoadError] = useState("");
  const lang = settings?.language || "en";
  const close = useCallback(() => { void CloseConnectionWindow().catch(err => setNotice(String(err))); }, []);
  const initialised = useRef(false);

  useEffect(() => {
    let live = true;
    let sequence = 0;
    const refresh = async () => {
      const revision = ++sequence;
      try {
        const [list, preferences] = await Promise.all([ListProfiles(), GetSettings()]);
        if (!live || revision !== sequence) return;
        setProfiles(list || []);
        setSettings(preferences);
        if (!initialised.current) {
          const profile = kind === "edit" ? list?.find(entry => entry.id === id) : emptyProfile();
          if (!profile) throw new Error(t(preferences.language, "closedProfileUnavailable"));
          setInitial(profile);
          initialised.current = true;
        }
        setLoadError("");
      } catch (error) {
        if (live && revision === sequence) setLoadError(String(error));
      }
    };
    const off = EventsOn("profiles:changed", refresh);
    window.addEventListener("focus", refresh);
    void refresh();
    return () => { live = false; off(); window.removeEventListener("focus", refresh); };
  }, [id, kind]);

  useEffect(() => {
    if (kind !== "new") return;
    const offPrompt = EventsOn("connection:keyboard-interactive", setChallenge);
    const offClosed = EventsOn("connection:keyboard-interactive:closed", ({ requestId }: KiRequest) => {
      setChallenge(current => current?.requestId === requestId ? undefined : current);
    });
    return () => { offPrompt(); offClosed(); };
  }, [kind]);

  const answer = async (requestId: string, answers: string[], cancelled: boolean) => {
    try { await AnswerKeyboardInteractive(requestId, answers, cancelled); }
    catch (error) { setNotice(String(error)); }
    finally { setChallenge(current => current?.requestId === requestId ? undefined : current); }
  };

  const save = async (profile: types.Profile) => {
    try { return await SaveConnectionProfile(profile); }
    catch (error) {
      if (String(error).includes("profile_changed")) throw new Error(t(lang, "profileChanged"), { cause: error });
      throw error;
    }
  };
  return <div className="app-shell connection-window" data-theme={normalizeAppTheme(settings?.themeName)}>
    {initial && settings && <>
      {(kind === "new" || kind === "edit") && <ProfileModal standalone profile={initial} profiles={profiles} language={lang}
        terminalDefaults={settings.terminal} sessionLogDefaults={settings.sessionLog} onClose={close}
        onTestConnection={kind === "new" ? (profile, signal) => TestProfileConnection(profile).cancelOn(signal) : undefined}
        onSave={async profile => { await save(profile); close(); }} onPickKey={SelectPrivateKey}
        onDelete={() => setDeleting(true)} onDuplicate={async profileID => { await DuplicateProfile(profileID); setNotice(t(lang, "profileCopied")); }}/>}
      {kind === "quick" && <QuickConnectModal standalone language={lang} onClose={close} onPickKey={SelectPrivateKey}
        onSave={save} onConnect={SubmitQuickConnection}/>}
      {kind === "bulk" && <BulkProfilesModal standalone profiles={profiles} language={lang} onClose={close}
        onSave={async (ids, patch) => { await UpdateProfilesBatch(ids, patch); }}/>}
      {challenge && <KeyboardInteractiveDialog key={challenge.requestId} request={challenge} language={lang}
        onSubmit={answers => void answer(challenge.requestId, answers, false)}
        onCancel={() => void answer(challenge.requestId, [], true)}/>}
      {deleting && <ConfirmDialog locale={lang} title={t(lang, "deleteProfileConfirm")}
        body={t(lang, "deleteProfileConfirmBody", { name: initial.name || initial.host })} confirmText={t(lang, "delete")}
        onClose={() => setDeleting(false)} onConfirm={async () => { await DeleteProfile(initial.id); close(); }}/>}
    </>}
    {loadError && <p role="alert" className="connection-notice">{loadError}</p>}
    {notice && <button className="connection-notice" onClick={() => setNotice("")}>{notice}</button>}
  </div>;
}
