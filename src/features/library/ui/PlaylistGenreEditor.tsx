import { useMemo, useState } from "react";
import { LuPencil, LuPlus, LuX } from "react-icons/lu";
import { useTranslation } from "@/languages";
import {
  normalizeGenreLabel,
  playlistGenreStore,
  useAllKnownGenreLabels,
  usePlaylistGenreLabels,
} from "@/features/genres/playlistGenreStore";
import { genreForTrack } from "@/features/genres/trackGenres";

// The Playlist Genre surface on a playlist (Step 5, S5-0): the labels
// the owner gave this playlist, shown as chips, and the editor that
// assigns them. Editing writes only to the local overlay
// (playlistGenreStore) — playlists are server-owned, no server call
// exists or is faked, and the panel says so: labels live on this
// device only.
//
// Basic Genres (source-provided) render below in a different chip
// style, read-only: they are source data, not owner data, and today
// no source provides them, so that row simply does not appear.

const PLAYLIST_GENRE_CHIP_CLASS =
  "inline-flex h-[24px] items-center gap-[5px] rounded-[8px] px-[9px] text-caption font-[400] text-text-primary select-none bg-black/[0.05] dark:bg-white/[0.1]";

const GENRE_CHIP_CLASS =
  "inline-flex h-[24px] items-center gap-[5px] rounded-[8px] px-[9px] text-caption font-[400] text-text-secondary select-none border border-border-alpha-14 bg-transparent";

/** Read-only Playlist Genre chips for a playlist (card + header use). */
export function PlaylistGenreChips({
  playlistId,
  limit,
}: {
  playlistId: string;
  limit?: number;
}) {
  const labels = usePlaylistGenreLabels(playlistId);
  if (labels.length === 0) return null;
  const shown = limit === undefined ? labels : labels.slice(0, limit);
  const hidden = labels.length - shown.length;
  return (
    <span className="flex flex-wrap items-center gap-[4px]">
      {shown.map((label) => (
        <span key={label} className={PLAYLIST_GENRE_CHIP_CLASS}>
          {label}
        </span>
      ))}
      {hidden > 0 ? (
        <span className="text-caption text-text-tertiary">+{hidden}</span>
      ) : null}
    </span>
  );
}

export default function PlaylistGenreEditor({
  playlistId,
  trackIds,
}: {
  playlistId: string;
  /** The playlist's tracks, for the read-only basic Genre aggregate. */
  trackIds?: string[];
}) {
  const { t } = useTranslation();
  const labels = usePlaylistGenreLabels(playlistId);
  const knownLabels = useAllKnownGenreLabels();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");

  const suggestions = useMemo(() => {
    const carried = new Set(labels.map(normalizeGenreLabel));
    return knownLabels.filter(
      (label) => !carried.has(normalizeGenreLabel(label)),
    );
  }, [knownLabels, labels]);

  const basicGenres = useMemo(() => {
    if (!trackIds || trackIds.length === 0) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const trackId of trackIds) {
      for (const genre of genreForTrack(trackId)) {
        const key = genre.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(genre);
      }
    }
    return out;
  }, [trackIds]);

  const addDraft = () => {
    if (playlistGenreStore.addLabel(playlistId, draft)) setDraft("");
  };

  return (
    <div className="mt-[10px] flex flex-col gap-[6px]" data-no-window-drag>
      <div className="flex flex-wrap items-center gap-[6px]">
        <span className="text-caption font-[500] text-text-tertiary">
          {t("genres.playlist_genre")}
        </span>
        {labels.map((label) => (
          <span key={label} className={PLAYLIST_GENRE_CHIP_CLASS}>
            {label}
          </span>
        ))}
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="inline-flex h-[24px] cursor-pointer items-center gap-[4px] rounded-[8px] border-0 bg-transparent px-[7px] text-caption font-[400] text-text-secondary transition-colors hover:text-text-primary"
        >
          <LuPencil size={12} />
          <span>
            {open
              ? t("genres.done")
              : labels.length > 0
                ? t("genres.edit_labels")
                : t("genres.add_labels")}
          </span>
        </button>
      </div>

      {basicGenres.length > 0 ? (
        <div className="flex flex-wrap items-center gap-[6px]">
          <span className="text-caption font-[500] text-text-tertiary">
            {t("genres.genre")}
          </span>
          {basicGenres.map((genre) => (
            <span key={genre} className={GENRE_CHIP_CLASS}>
              {genre}
            </span>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="flex max-w-[560px] flex-col gap-[8px] rounded-[12px] bg-black/[0.04] p-[10px] dark:bg-white/[0.06]">
          {labels.length > 0 ? (
            <div className="flex flex-wrap items-center gap-[5px]">
              {labels.map((label) => (
                <span key={label} className={PLAYLIST_GENRE_CHIP_CLASS}>
                  {label}
                  <button
                    type="button"
                    aria-label={t("genres.remove_label", { label })}
                    onClick={() =>
                      playlistGenreStore.removeLabel(playlistId, label)
                    }
                    className="flex cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-text-secondary transition-colors hover:text-text-primary"
                  >
                    <LuX size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          <div className="flex items-center gap-[6px]">
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addDraft();
                }
              }}
              placeholder={t("genres.add_label_placeholder")}
              aria-label={t("genres.add_label_placeholder")}
              spellCheck={false}
              autoComplete="off"
              className="h-[30px] min-w-0 flex-1 rounded-[8px] border border-border-alpha-14 bg-transparent px-[9px] text-label text-text-primary outline-none placeholder:text-text-tertiary"
            />
            <button
              type="button"
              onClick={addDraft}
              disabled={draft.trim().length === 0}
              className="inline-flex h-[30px] shrink-0 cursor-pointer items-center gap-[4px] rounded-[8px] border-0 bg-btn-primary-bg px-[12px] text-label font-[500] text-btn-primary-text transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
            >
              <LuPlus size={13} />
              <span>{t("genres.add")}</span>
            </button>
          </div>

          {suggestions.length > 0 ? (
            <div className="flex flex-col gap-[5px]">
              <span className="text-caption font-[500] text-text-tertiary">
                {t("genres.your_labels")}
              </span>
              <div className="flex flex-wrap items-center gap-[5px]">
                {suggestions.map((label) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() =>
                      playlistGenreStore.addLabel(playlistId, label)
                    }
                    className={`${PLAYLIST_GENRE_CHIP_CLASS} cursor-pointer border-0 transition-colors hover:bg-black/[0.09] dark:hover:bg-white/[0.16]`}
                  >
                    <LuPlus size={11} />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <span className="text-caption text-text-tertiary">
            {t("genres.labels_local_note")}
          </span>
        </div>
      ) : null}
    </div>
  );
}
