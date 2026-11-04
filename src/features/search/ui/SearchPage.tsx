import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  AlbumFill,
  CloseCircleFill,
  FilterLine,
  GridFill,
  Music2Fill,
  PlaylistFill,
  Search3Line,
  User2Fill,
} from "@mingcute/react";
import { playerEngine } from "@/features/player";
import { useOfflineModeStore } from "@/features/connectivity";
import {
  collectionPath,
  collectionPreviewState,
} from "@/features/collection/lib/collectionPreview";
import AlbumCard from "@/features/collection/ui/AlbumCard";
import PlaylistCard from "@/features/library/ui/PlaylistCard";
import SongCardWithMenu from "@/features/player/ui/SongCardWithMenu";
import { useAllInUseGenreLabels } from "@/features/genres/playlistGenreStore";
import { useTranslation } from "@/languages";
import { useSearchAll } from "../hooks/useSearchAll";
import { useSearchTracks } from "../hooks/useSearchTracks";
import { useSearchArtists } from "../hooks/useSearchArtists";
import { useSearchAlbums } from "../hooks/useSearchAlbums";
import { useSearchPlaylists } from "../hooks/useSearchPlaylists";
import { useSearchHistoryStore } from "../store/searchHistoryStore";
import { SearchHistoryList } from "./SearchHistoryList";
import { SearchHeroArtist } from "./SearchHeroArtist";
import {
  formatSearchDuration,
  mapSearchAlbumItems,
  mapSearchAllItems,
  mapSearchArtistItems,
  mapSearchPlaylistItems,
  mapSearchTrackItems,
  partitionSearchRows,
  provenSourceLabel,
  type SearchRowItem,
} from "../lib/searchPageItems";

// The dedicated Search page (interface programme S1; reference 04
// governs the form). It is the destination of the sidebar's search
// field (Conflict 9's settlement: the field is the quick door, this
// page is the room) and it reuses the search feature's shipped
// machinery whole — the five per-type hooks, the persisted recent-
// searches store, the history list — over a full page instead of
// the AppFrame overlay popup, which retires when this page lands
// (the retirement edit is the integration pass's, per the plan).
//
// State honesty, per the plan:
//  - before typing: recent searches + the listener's own Playlist
//    Genre labels as browse chips. NO "trending searches" — no such
//    source exists and nothing is dressed up as one.
//  - a failed search is NOT an empty search: the failure state
//    carries its own retry and never renders as "no results".
//  - offline, search (a server function) says so and doors to the
//    local shelves instead of showing a silent empty list.

type SearchFilter = "all" | "tracks" | "artists" | "albums" | "playlists";

const FILTERS: ReadonlyArray<{
  key: SearchFilter;
  labelKey: string;
  Icon: typeof GridFill;
}> = [
  { key: "all", labelKey: "search.all", Icon: GridFill },
  { key: "tracks", labelKey: "search.songs", Icon: Music2Fill },
  { key: "artists", labelKey: "search.artists", Icon: User2Fill },
  { key: "albums", labelKey: "search.albums", Icon: AlbumFill },
  { key: "playlists", labelKey: "search.playlists", Icon: PlaylistFill },
];

function kindOfRow(row: any): SearchRowItem["_type"] | null {
  const type = row?._type ?? row?.type;
  if (
    type === "artist" ||
    row?.followers !== undefined ||
    row?.monthlyListeners !== undefined
  )
    return "artist";
  if (type === "playlist" || row?.owner !== undefined) return "playlist";
  if (
    type === "album" ||
    row?.totalTracks !== undefined ||
    row?.total_tracks !== undefined
  )
    return "album";
  if (type === "track") return "track";
  return null;
}

function SectionBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-rim pt-[18px]">
      <h2 className="m-0 pb-[14px] text-[20px] font-[600] tracking-tight text-text-primary">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function SearchPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const offline = useOfflineModeStore((state) => state.offline);

  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [activeFilter, setActiveFilter] = useState<SearchFilter>("all");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // The sidebar's quick door carries its query in the URL; when a
  // new one arrives while the page is already open, adopt it.
  const carriedQuery = searchParams.get("q");
  const lastCarriedRef = useRef(carriedQuery);
  useEffect(() => {
    if (carriedQuery === null || carriedQuery === lastCarriedRef.current)
      return;
    lastCarriedRef.current = carriedQuery;
    setQuery(carriedQuery);
  }, [carriedQuery]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const addHistoryItem = useSearchHistoryStore((state) => state.addItem);
  const genreLabels = useAllInUseGenreLabels();

  const enabled = !offline;
  const all = useSearchAll(query, {
    enabled: enabled && activeFilter === "all",
    limit: 20,
    debounceMs: 320,
  });
  const tracksHook = useSearchTracks(query, {
    enabled: enabled && activeFilter === "tracks",
    limit: 20,
    debounceMs: 320,
  });
  const artistsHook = useSearchArtists(query, {
    enabled: enabled && activeFilter === "artists",
    limit: 20,
    debounceMs: 320,
  });
  const albumsHook = useSearchAlbums(query, {
    enabled: enabled && activeFilter === "albums",
    limit: 20,
    debounceMs: 320,
  });
  const playlistsHook = useSearchPlaylists(query, {
    enabled: enabled && activeFilter === "playlists",
    limit: 20,
    debounceMs: 320,
  });

  const active = useMemo(() => {
    switch (activeFilter) {
      case "tracks":
        return {
          rows: mapSearchTrackItems(tracksHook.tracks),
          loading: tracksHook.loading,
          hasLoaded: tracksHook.hasLoaded,
          error: tracksHook.error,
          runNow: tracksHook.runNow,
          partialWarning: tracksHook.partialWarning,
        };
      case "artists":
        return {
          rows: mapSearchArtistItems(artistsHook.artists),
          loading: artistsHook.loading,
          hasLoaded: artistsHook.hasLoaded,
          error: artistsHook.error,
          runNow: artistsHook.runNow,
          partialWarning: artistsHook.partialWarning,
        };
      case "albums":
        return {
          rows: mapSearchAlbumItems(albumsHook.albums),
          loading: albumsHook.loading,
          hasLoaded: albumsHook.hasLoaded,
          error: albumsHook.error,
          runNow: albumsHook.runNow,
          partialWarning: albumsHook.partialWarning,
        };
      case "playlists":
        return {
          rows: mapSearchPlaylistItems(playlistsHook.playlists),
          loading: playlistsHook.loading,
          hasLoaded: playlistsHook.hasLoaded,
          error: playlistsHook.error,
          runNow: playlistsHook.runNow,
          partialWarning: playlistsHook.partialWarning,
        };
      default:
        return {
          rows: mapSearchAllItems(all.items),
          loading: all.loading,
          hasLoaded: all.hasLoaded,
          error: all.error,
          runNow: all.runNow,
          partialWarning: all.partialWarning,
        };
    }
  }, [activeFilter, all, tracksHook, artistsHook, albumsHook, playlistsHook]);

  const blocks = useMemo(() => partitionSearchRows(active.rows), [active.rows]);

  const trimmed = query.trim();
  const hasQuery = trimmed.length >= 2;
  const showResults = hasQuery && active.rows.length > 0;
  const isFailure =
    hasQuery && !active.loading && active.hasLoaded && active.error !== null;
  const isEmpty =
    hasQuery &&
    !active.loading &&
    active.hasLoaded &&
    active.error === null &&
    active.rows.length === 0;

  const handlePlayTrack = useCallback(
    (track: any) => {
      playerEngine.primeUserGesture();
      if (!track) return;
      const durationMs = track.durationMs ?? track.duration_ms;
      addHistoryItem({
        id: track.id,
        type: "track",
        title: track.title,
        subtitle: track.artists,
        coverUrl: track.coverUrl,
        explicit: track.explicit,
        duration: formatSearchDuration(durationMs) || undefined,
        durationMs,
        itemData: track,
      });
      void playerEngine.playTrack(
        track,
        [track],
        `${track.title} Radio`,
        track.coverUrl,
      );
    },
    [addHistoryItem],
  );

  const recordHistoryFor = useCallback(
    (item: any) => {
      if (!item) return;
      const kind = kindOfRow(item);
      if (kind === "artist") {
        addHistoryItem({
          id: item.id,
          type: "artist",
          title: item.name || item.title,
          subtitle: t("common.artists"),
          coverUrl: item.coverUrl,
          itemData: item,
        });
      } else if (kind === "playlist") {
        addHistoryItem({
          id: item.id,
          type: "playlist",
          title: item.name || item.title,
          subtitle: item.author || item.owner || t("common.playlists"),
          coverUrl: item.coverUrl,
          itemData: item,
        });
      } else if (kind === "album") {
        addHistoryItem({
          id: item.id,
          type: "album",
          title: item.name || item.title,
          subtitle: item.artists || item.artist || t("common.albums"),
          coverUrl: item.coverUrl,
          itemData: item,
        });
      }
    },
    [addHistoryItem, t],
  );

  const handleNavigateItem = useCallback(
    (item: any) => {
      if (!item) return;
      recordHistoryFor(item);
      const kind = kindOfRow(item);
      if (kind === "artist") {
        navigate(`/artist?id=${encodeURIComponent(item.id)}`);
      } else if (kind === "playlist") {
        navigate(collectionPath("playlist", item.id), {
          state: collectionPreviewState({
            coverUrl: item.coverUrl,
            title: item.name || item.title,
            subtitle: item.author || item.owner,
          }),
        });
      } else if (kind === "album") {
        navigate(collectionPath("album", item.id), {
          state: collectionPreviewState({
            coverUrl: item.coverUrl,
            title: item.name || item.title,
            subtitle: item.artists || item.artist,
          }),
        });
      }
    },
    [navigate, recordHistoryFor],
  );

  const submitQuery = useCallback(() => {
    if (!trimmed) return;
    addHistoryItem({
      id: `query:${trimmed.toLowerCase()}`,
      type: "query",
      title: trimmed,
    });
    active.runNow();
  }, [addHistoryItem, trimmed, active]);

  const handleSelectHistoryQuery = useCallback(
    (queryText: string) => {
      setQuery(queryText);
      const text = queryText.trim();
      if (text) {
        addHistoryItem({
          id: `query:${text.toLowerCase()}`,
          type: "query",
          title: text,
        });
      }
      inputRef.current?.focus();
    },
    [addHistoryItem],
  );

  const handleGenreChip = useCallback((label: string) => {
    // Before the Genres surface exists (S5), a label chip runs the
    // label itself as a catalogue search — a real action today.
    setQuery(label);
    inputRef.current?.focus();
  }, []);

  return (
    <div className="relative h-full w-full overflow-y-auto overflow-x-hidden bg-transparent pt-(--page-inset-top) pb-(--page-inset-bottom)">
      <div className="flex w-full flex-col gap-[20px] px-[28px] pt-[10px]">
        {/* The query bar — reference 04: one wide, fully-rounded
            field spanning the content width; magnifier, the query,
            a clear ✕ and the round filter button at its right. */}
        <div className="flex h-[54px] items-center gap-[14px] rounded-full border border-rim bg-bg-panel px-[18px]">
          <span className="flex shrink-0 items-center justify-center text-text-tertiary">
            {active.loading && hasQuery ? (
              <span
                className="inline-block h-[17px] w-[17px] animate-spin rounded-full border-[1.5px] border-text-secondary border-t-transparent"
                aria-hidden="true"
              />
            ) : (
              <Search3Line size={19} />
            )}
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitQuery();
              }
            }}
            placeholder={t("search.placeholder")}
            aria-label={t("common.search")}
            className="w-full flex-1 border-none bg-transparent text-[16px] font-[400] tracking-tight text-text-primary outline-none placeholder:text-text-tertiary"
            style={{ lineHeight: "1.2" }}
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label={t("search.page.clear_query")}
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="flex shrink-0 cursor-pointer items-center justify-center border-none bg-transparent p-0 text-text-tertiary transition-colors hover:text-text-primary"
            >
              <CloseCircleFill size={18} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t("search.page.toggle_filters")}
            aria-pressed={filtersOpen}
            onClick={() => setFiltersOpen((open) => !open)}
            className={`flex h-[34px] w-[34px] shrink-0 cursor-pointer items-center justify-center rounded-full border-none transition-colors ${
              filtersOpen
                ? "bg-accent-gradient text-white"
                : "bg-border-alpha-14 text-text-secondary hover:text-text-primary"
            }`}
          >
            <FilterLine size={17} />
          </button>
        </div>

        {filtersOpen ? (
          <div className="flex flex-wrap gap-[6px]">
            {FILTERS.map(({ key, labelKey, Icon }) => {
              const isActive = activeFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveFilter(key)}
                  aria-pressed={isActive}
                  className={`flex cursor-pointer items-center gap-[7px] rounded-full border-none px-[13px] py-[7px] text-[13.5px] transition-colors select-none ${
                    isActive
                      ? "bg-border-alpha-14 font-medium text-text-primary"
                      : "bg-transparent text-text-secondary hover:bg-border-alpha-14 hover:text-text-primary"
                  }`}
                  style={{ lineHeight: "1.2" }}
                >
                  <Icon size={15} />
                  <span>{t(labelKey)}</span>
                </button>
              );
            })}
          </div>
        ) : null}

        {offline ? (
          <div className="flex min-h-[40vh] flex-col items-center justify-center gap-[8px] px-[24px] text-center">
            <p className="m-0 text-title font-[600] text-text-primary">
              {t("search.page.offline_title")}
            </p>
            <p className="m-0 max-w-[420px] text-body text-text-tertiary">
              {t("search.page.offline_hint")}
            </p>
            <div className="mt-[10px] flex items-center gap-[8px]">
              <Link
                to="/library/cached"
                className="rounded-full bg-border-alpha-14 px-[16px] py-[8px] text-label font-[500] text-text-primary no-underline transition-colors hover:bg-border-alpha-20"
              >
                {t("common.sidebar.downloads")}
              </Link>
              <Link
                to="/library"
                className="rounded-full bg-border-alpha-14 px-[16px] py-[8px] text-label font-[500] text-text-primary no-underline transition-colors hover:bg-border-alpha-20"
              >
                {t("common.sidebar.library")}
              </Link>
            </div>
          </div>
        ) : !hasQuery ? (
          <div className="flex flex-col gap-[22px]">
            <SearchHistoryList
              onSelectQuery={handleSelectHistoryQuery}
              onPlayTrack={handlePlayTrack}
              onNavigateItem={handleNavigateItem}
            />
            {genreLabels.length > 0 ? (
              <div className="flex flex-col gap-[10px]">
                <span className="px-[6px] text-body font-medium tracking-tight text-text-secondary">
                  {t("search.page.genre_chips_title")}
                </span>
                <div className="flex flex-wrap gap-[8px] px-[6px]">
                  {genreLabels.map((label) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => handleGenreChip(label)}
                      className="cursor-pointer rounded-full bg-border-alpha-14 px-[14px] py-[7px] text-label text-text-primary transition-colors select-none hover:bg-border-alpha-20"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-[26px]">
            <span className="text-caption font-[600] tracking-[0.12em] text-text-tertiary uppercase">
              {t("search.page.results_eyebrow")}
            </span>

            {active.partialWarning ? (
              <p className="m-0 text-caption text-accent-tertiary">
                {active.partialWarning}
              </p>
            ) : null}

            {active.loading && !showResults ? (
              <p className="m-0 py-[30px] text-center text-body text-text-tertiary">
                {t("common.loading")}
              </p>
            ) : isFailure ? (
              <div className="flex flex-col items-center justify-center gap-[6px] px-[20px] py-[40px] text-center">
                <p className="m-0 text-label font-medium text-text-primary">
                  {t("search.page.error_title")}
                </p>
                <p className="m-0 max-w-[440px] text-caption text-text-tertiary">
                  {t("search.page.error_hint")}
                </p>
                <button
                  type="button"
                  onClick={() => active.runNow()}
                  className="mt-[8px] cursor-pointer rounded-full bg-border-alpha-14 px-[16px] py-[8px] text-label font-[500] text-text-primary transition-colors hover:bg-border-alpha-20"
                >
                  {t("search.page.retry")}
                </button>
              </div>
            ) : isEmpty ? (
              <div className="flex flex-col items-center justify-center gap-[6px] px-[20px] py-[40px] text-center">
                <p className="m-0 text-label font-medium text-text-primary">
                  {t("search.page.no_results_for", { query: trimmed })}
                </p>
                <p className="m-0 max-w-[460px] text-caption text-text-tertiary">
                  {t("search.page.no_results_hint")}
                </p>
                <p className="m-0 text-caption text-text-tertiary">
                  {t("search.page.no_results_source")}
                </p>
                {activeFilter !== "all" ? (
                  <button
                    type="button"
                    onClick={() => setActiveFilter("all")}
                    className="mt-[8px] cursor-pointer rounded-full bg-border-alpha-14 px-[16px] py-[8px] text-label font-[500] text-text-primary transition-colors hover:bg-border-alpha-20"
                  >
                    {t("search.page.search_everything")}
                  </button>
                ) : null}
              </div>
            ) : showResults ? (
              <>
                {blocks.tracks.length > 0 ? (
                  <SectionBlock title={t("search.songs")}>
                    <div className="flex flex-col gap-[6px]">
                      {blocks.tracks.map((row) => {
                        const durationMs = row.durationMs ?? row.duration_ms;
                        return (
                          <SongCardWithMenu
                            key={row.id}
                            id={row.id}
                            title={row.title || row.name || ""}
                            artistId={row.artistId ?? row.artist_id}
                            artistList={row.artistList}
                            artists={row.artists || ""}
                            coverUrl={row.coverUrl || ""}
                            explicit={row.explicit}
                            duration={formatSearchDuration(durationMs)}
                            durationMs={durationMs}
                            searchType="track"
                            onPlay={() => handlePlayTrack(row)}
                            onNavigate={() => handlePlayTrack(row)}
                          />
                        );
                      })}
                    </div>
                  </SectionBlock>
                ) : null}

                {blocks.artists.length > 0 ? (
                  <SectionBlock title={t("search.artists")}>
                    <SearchHeroArtist
                      hero={blocks.artists[0]}
                      related={blocks.artists.slice(1)}
                      onNavigateArtist={handleNavigateItem}
                    />
                  </SectionBlock>
                ) : null}

                {blocks.albums.length > 0 ? (
                  <SectionBlock title={t("search.albums")}>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-[18px] gap-y-[24px]">
                      {blocks.albums.map((row) => {
                        const source = provenSourceLabel(row.id);
                        return (
                          // AlbumCard's own Link navigates; the
                          // wrapper only records the visit in the
                          // recent-searches history.
                          <div
                            key={row.id}
                            onClick={() => recordHistoryFor(row)}
                          >
                            <AlbumCard
                              id={row.id}
                              title={row.title || row.name || ""}
                              coverUrl={row.coverUrl || ""}
                              year={row.year ? String(row.year) : undefined}
                              trackCount={
                                row.totalTracks ?? row.trackCount ?? undefined
                              }
                              badge={
                                source ? (
                                  <span className="shrink-0 rounded-full bg-border-alpha-14 px-[7px] py-[1px] text-[10.5px] font-[500] text-text-secondary">
                                    {source}
                                  </span>
                                ) : undefined
                              }
                            />
                          </div>
                        );
                      })}
                    </div>
                  </SectionBlock>
                ) : null}

                {blocks.playlists.length > 0 ? (
                  <SectionBlock title={t("search.playlists")}>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-[18px] gap-y-[24px]">
                      {blocks.playlists.map((row) => {
                        const source = provenSourceLabel(row.id);
                        return (
                          // PlaylistCard's own Link navigates; the
                          // wrapper only records the visit in the
                          // recent-searches history.
                          <div
                            key={row.id}
                            onClick={() => recordHistoryFor(row)}
                          >
                            <PlaylistCard
                              title={row.title || row.name || ""}
                              author={
                                row.author || row.owner || row.artists || ""
                              }
                              imageUrl={row.coverUrl || ""}
                              href={collectionPath("playlist", row.id)}
                              linkState={collectionPreviewState({
                                coverUrl: row.coverUrl,
                                title: row.name || row.title,
                                subtitle: row.author || row.owner,
                              })}
                              badge={
                                source ? (
                                  <span className="shrink-0 rounded-full bg-border-alpha-14 px-[7px] py-[1px] text-[10.5px] font-[500] text-text-secondary">
                                    {source}
                                  </span>
                                ) : undefined
                              }
                            />
                          </div>
                        );
                      })}
                    </div>
                  </SectionBlock>
                ) : null}
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
