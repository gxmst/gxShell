import { parseWorkspaces, WORKSPACES_KEY } from "./workspaces";
import { t } from "../i18n";

// Reserve browser storage before changing native config. If the native
// transaction fails, restore the exact previous value (including a missing key).
export async function applyBackupWorkspaces(previous: string | null, next: string, apply: () => Promise<void>, locale = "en") {
  const workspaces = parseWorkspaces(next, locale);
  if (localStorage.getItem(WORKSPACES_KEY) !== previous) {
    throw new Error(t(locale, "workspacesChangedSincePreview"));
  }
  localStorage.setItem(WORKSPACES_KEY, next);
  try {
    await apply();
  } catch (error) {
    try {
      if (localStorage.getItem(WORKSPACES_KEY) !== next) {
        throw new Error(t(locale, "workspacesChangedDuringImport"), { cause: error });
      }
      if (previous === null) localStorage.removeItem(WORKSPACES_KEY);
      else localStorage.setItem(WORKSPACES_KEY, previous);
    } catch (rollbackError) {
      throw new Error(t(locale, "workspacesRollbackFailed", { error: String(error), rollback: String(rollbackError) }), { cause: rollbackError });
    }
    throw error;
  }
  return workspaces;
}
