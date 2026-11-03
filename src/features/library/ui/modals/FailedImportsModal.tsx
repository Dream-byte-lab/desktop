import { useEffect, useMemo, useState } from "react";
import Dialog from "@/shared/ui/Dialog";
import { DialogActions, DialogButton } from "@/shared/ui";
import { notifyLibraryChanged } from "../../hooks/usePlaylists";
import {
  failedImportReasonWords,
  failedImports,
  type FailedImportEntry,
} from "../../services/import/failures/failedImportsStore";
import { FAILED_PLAYLIST_TITLE } from "../../services/import/failures/failedPlaylist";
import { recoverFailedImports } from "../../services/import/failures/recoverFailedImports";
import { useModalStore } from "../../store/modalStore";

// The visible face of the ONE failed-songs playlist ("Could not
// import"): every song that could not come across in an import is
// saved into it automatically, during the import, and listed here
// with the reason in plain words. Nothing here is playable yet —
// these are the songs still waiting for a match. Retry re-runs the
// matching; songs that now match confidently are saved into a
// "<playlist> — recovered" playlist and leave this one, and songs
// that still cannot match stay, with their reason refreshed.

export default function FailedImportsModal() {
  const open = useModalStore((state) => state.failedImportsOpen);
  const closeFailedImports = useModalStore((state) => state.closeFailedImports);
  const [entries, setEntries] = useState<FailedImportEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (open) {
      setEntries(failedImports.list());
      setNotice("");
    }
  }, [open]);

  const groups = useMemo(() => {
    const byTitle = new Map<string, FailedImportEntry[]>();
    for (const entry of entries) {
      const list = byTitle.get(entry.importTitle) ?? [];
      list.push(entry);
      byTitle.set(entry.importTitle, list);
    }
    return [...byTitle.entries()];
  }, [entries]);

  const close = () => closeFailedImports();

  const removeEntry = (entry: FailedImportEntry) => {
    failedImports.remove([entry.key]);
    setEntries(failedImports.list());
    notifyLibraryChanged();
  };

  const clearAll = () => {
    failedImports.clear();
    setEntries([]);
    setNotice("");
    notifyLibraryChanged();
  };

  const retryAll = async () => {
    if (busy || entries.length === 0) return;
    setBusy(true);
    setNotice("");
    try {
      const outcome = await recoverFailedImports(entries);
      if (outcome.recoveredCount > 0) notifyLibraryChanged();
      setEntries(failedImports.list());
      setNotice(
        outcome.recoveredCount > 0
          ? `Recovered ${outcome.recoveredCount} song${outcome.recoveredCount === 1 ? "" : "s"} into “recovered” playlists. ${outcome.stillFailingCount} still waiting for a match.`
          : "No new matches yet — the songs stay here for the next try.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !next && close()}
      maxWidth={520}
    >
      <div className="flex max-h-[70vh] flex-col gap-3 p-5">
        <div>
          <div className="text-base font-semibold text-text-primary">
            {FAILED_PLAYLIST_TITLE}
          </div>
          <p className="mt-1 text-[13px] text-text-secondary">
            Every song that could not come across in an import is saved into
            this playlist automatically, while the import runs — nothing is lost
            silently, and there is only ever this one playlist for all of them.
            When a song's match appears later, retry brings it home.
          </p>
        </div>

        {entries.length === 0 ? (
          <p className="text-sm text-text-secondary">
            Nothing is waiting — every import has come across whole.
          </p>
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {groups.map(([title, group]) => (
              <div key={title}>
                <div className="mb-1 text-xs font-semibold tracking-wide text-text-secondary uppercase">
                  From “{title}”
                </div>
                <div className="space-y-1.5">
                  {group.map((entry) => (
                    <div
                      key={entry.key}
                      className="flex items-start justify-between gap-3 rounded-xl bg-black/[0.04] px-3 py-2 dark:bg-white/[0.06]"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm text-text-primary">
                          {entry.sourceTrack.title}
                          <span className="text-text-secondary">
                            {" "}
                            · {entry.sourceTrack.artists.join(", ")}
                          </span>
                        </div>
                        <div className="text-xs text-text-secondary">
                          {failedImportReasonWords(entry.reason)}
                          {entry.attempts > 1
                            ? ` · tried ${entry.attempts} times`
                            : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeEntry(entry)}
                        className="shrink-0 text-text-tertiary transition-colors hover:text-text-primary"
                        title="Remove from the list"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {notice ? (
          <p className="text-[13px] text-text-secondary">{notice}</p>
        ) : null}

        <DialogActions className="mt-1">
          {entries.length > 0 ? (
            <DialogButton type="button" onClick={clearAll} disabled={busy}>
              Clear all
            </DialogButton>
          ) : null}
          <DialogButton type="button" onClick={close} disabled={busy}>
            Close
          </DialogButton>
          {entries.length > 0 ? (
            <DialogButton
              type="button"
              variant="primary"
              loading={busy}
              onClick={() => void retryAll()}
            >
              Retry all
            </DialogButton>
          ) : null}
        </DialogActions>
      </div>
    </Dialog>
  );
}
