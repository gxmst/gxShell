import { useCallback, useEffect, useRef, useState } from "react";
import { EventsOn } from "../../wailsjs/runtime/runtime";
import { types } from "../../wailsjs/go/models";
import { CreateProfile, DeleteProfile, DuplicateProfile, GetAppInfo, GetSettings, ListCommands, ListProfiles, UpdateProfile, UpdateSettings } from "../../wailsjs/go/app/App";
import { appThemes } from "../constants";

export function useProfiles(notify: (text: string, tone?: "info" | "error" | "success") => void) {
  const [profiles, setProfiles] = useState<types.Profile[]>([]);
  const [commands, setCommands] = useState<types.CommandTemplate[]>([]);
  const [settings, setSettings] = useState<types.AppSettings | null>(null);
  const [appInfo, setAppInfo] = useState<Record<string, string>>({});
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const listRevision = useRef(0);
  const refreshProfiles = useCallback(async () => {
    const revision = ++listRevision.current;
    const list = await ListProfiles();
    if (mounted.current && revision === listRevision.current) setProfiles(list || []);
  }, []);

  useEffect(() => EventsOn("profiles:changed", () => {
    void refreshProfiles().catch(err => notify(String(err), "error"));
  }), [refreshProfiles, notify]);

  const reload = useCallback(async () => {
    const [, commandList, currentSettings, info] = await Promise.all([
      refreshProfiles(),
      ListCommands(),
      GetSettings(),
      GetAppInfo()
    ]);
    if (!mounted.current) return;
    if (!appThemes.includes(currentSettings.themeName)) currentSettings.themeName = "Light";
    if (!currentSettings.terminal.themeName || currentSettings.terminal.themeName === "gx Dark") {
      currentSettings.terminal.themeName = currentSettings.themeName === "Light" ? "Light" : currentSettings.themeName;
    }
    setCommands(commandList);
    setSettings(currentSettings);
    setAppInfo(info);
  }, [refreshProfiles]);

  useEffect(() => {
    reload().catch((err) => notify(String(err), "error"));
  }, [reload, notify]);

  const saveProfile = useCallback(async (profile: types.Profile) => {
    const saved = profile.id ? await UpdateProfile(profile) : await CreateProfile(profile);
    await reload();
    return saved;
  }, [reload]);

  const deleteProfile = useCallback(async (id: string) => {
    await DeleteProfile(id);
    await reload();
  }, [reload]);

  const duplicateProfile = useCallback(async (id: string) => {
    await DuplicateProfile(id);
    await reload();
  }, [reload]);

  const saveSettings = useCallback(async (next: types.AppSettings) => {
    const saved = await UpdateSettings(next);
    setSettings(saved);
    return saved;
  }, []);

  return {
    profiles,
    commands,
    setCommands,
    settings,
    setSettings,
    appInfo,
    reload,
    saveProfile,
    deleteProfile,
    duplicateProfile,
    saveSettings
  };
}
