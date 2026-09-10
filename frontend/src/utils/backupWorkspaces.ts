import { parseWorkspaces, WORKSPACES_KEY } from "./workspaces";

// Reserve browser storage before changing native config. If the native
// transaction fails, restore the exact previous value (including a missing key).
export async function applyBackupWorkspaces(previous: string | null, next: string, apply: () => Promise<void>) {
  const workspaces = parseWorkspaces(next);
  if (localStorage.getItem(WORKSPACES_KEY) !== previous) {
    throw new Error("Workspaces changed since preview; preview again");
  }
  localStorage.setItem(WORKSPACES_KEY, next);
  try {
    await apply();
  } catch (error) {
    try {
      if (localStorage.getItem(WORKSPACES_KEY) !== next) {
        throw new Error("Workspaces changed during import; the newer changes were retained", { cause: error });
      }
      if (previous === null) localStorage.removeItem(WORKSPACES_KEY);
      else localStorage.setItem(WORKSPACES_KEY, previous);
    } catch (rollbackError) {
      throw new Error(`${String(error)}; workspace rollback failed: ${String(rollbackError)}`, { cause: rollbackError });
    }
    throw error;
  }
  return workspaces;
}
