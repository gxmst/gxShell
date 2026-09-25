import type { types } from "../../wailsjs/go/models";

/**
 * Presentation helpers for remote entries.
 *
 * Two things in the file browser exist only because a listing is not the whole
 * truth about a server-side tree: a symbolic link, which readdir reports as a
 * link and whose shape only the target reveals, and a folder download, which
 * deliberately leaves some entries behind.
 */

/** How many skipped paths a summary names before it stops. */
const MAX_NAMED_SKIPS = 3;

type RemoteEntry = Pick<types.RemoteFile, "path"> & {
  isLink?: boolean;
  linkTarget?: string;
};

/**
 * What a row shows on hover.
 *
 * For a link the path alone is ambiguous: /var/www/current could be a
 * directory, a file, or a link to either. Naming the target is what lets the
 * user tell "this is a directory to open" from "this is a file to download".
 */
export function remoteEntryTitle(file: RemoteEntry): string {
  if (file.isLink && file.linkTarget) return `${file.path} → ${file.linkTarget}`;
  return file.path;
}

function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index < 0 ? trimmed : trimmed.slice(index + 1);
}

/**
 * Name the entries a folder download left behind.
 *
 * "Finished" is not "complete": a folder download never follows links, and the
 * server may refuse individual entries. Without the names, a backup of
 * /etc/nginx that silently omitted sites-enabled looked like a good backup.
 * The list is capped because a tree with hundreds of links must not turn a
 * notification into a wall of text.
 */
export function formatSkippedEntries(
  skips: types.FolderDownloadSkip[],
  reasonLabel: (reason: string) => string,
  limit = MAX_NAMED_SKIPS,
): string {
  const named = skips
    .slice(0, limit)
    .map((skip) => `${lastSegment(skip.path)} (${reasonLabel(skip.reason)})`);
  const summary = named.join(", ");
  return skips.length > named.length ? `${summary} …` : summary;
}

/**
 * The i18n key describing why one entry was skipped. An unknown reason falls
 * back to a neutral label rather than to one of the known ones, so a newer
 * backend cannot make the summary claim the wrong cause.
 */
export function skipReasonLabelKey(
  reason: string,
): "folderSkipSymlink" | "folderSkipUnreadable" | "folderSkipOther" {
  if (reason === "unreadable") return "folderSkipUnreadable";
  if (reason === "symlink") return "folderSkipSymlink";
  return "folderSkipOther";
}
