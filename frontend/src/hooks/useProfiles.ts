import { useCallback, useEffect, useState } from "react";
import { types } from "../../wailsjs/go/models";
import { CreateProfile, DeleteProfile, DuplicateProfile, GetAppInfo, GetSettings, ListCommands, ListProfiles, UpdateProfile, UpdateSettings } from "../../wailsjs/go/main/App";
import { appThemes } from "../constants";

export function useProfiles(notify: (text: string, tone?: "info" | "error" | "success") => void) {
  const [profiles, setProfiles] = useState<types.Profile[]>([]);
  const [commands, setCommands] = useState<types.CommandTemplate[]>([]);
  const [settings, setSettings] = useState<types.AppSettings | null>(null);
  const [appInfo, setAppInfo] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    const [profileList, commandList, currentSettings, info] = await Promise.all([
      ListProfiles(),
      ListCommands(),
      GetSettings(),
      GetAppInfo()
    ]);
    if (!appThemes.includes(currentSettings.themeName)) currentSettings.themeName = "Dark";
    if (!currentSettings.terminal.themeName || currentSettings.terminal.themeName === "gx Dark") {
      currentSettings.terminal.themeName = currentSettings.themeName === "Light" ? "Light" : currentSettings.themeName;
    }
    setProfiles(profileList);
    setCommands(commandList);
    setSettings(currentSettings);
    setAppInfo(info);
  }, []);

  useEffect(() => {
    reload().catch((err) => notify(String(err), "error"));
  }, [reload, notify]);

  const saveProfile = useCallback(async (profile: types.Profile) => {
    if (profile.id) await UpdateProfile(profile);
    else await CreateProfile(profile);
    await reload();
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

