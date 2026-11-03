import {
  Search2Line,
  CloseLine,
  AddLine,
  GridLine,
  GridFill,
  ListCheckLine,
  ListCheckFill,
} from "@mingcute/react";
import Button from "@/shared/ui/Button";
import {
  HERO_BUTTON_CLASS,
  HERO_GLASS_BUTTON_CLASS,
  HERO_GLASS_CLASS,
  ToggleSwitch,
} from "@/shared/ui";
import type { LibraryTab, LibraryViewMode } from "../types";
import { useTranslation } from "@/languages";
import { useRomanizationStore } from "@/shared/text";

export interface GenreFilterControl {
  /** Every Playlist Genre label in use in the library. */
  labels: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
}

interface LibraryControlsProps {
  activeTab: LibraryTab;
  query: string;
  onQueryChange: (query: string) => void;
  viewMode: LibraryViewMode;
  onViewModeChange: (mode: LibraryViewMode) => void;
  /** shown only when provided (playlist tabs) */
  onCreatePlaylist?: () => void;
  /** Playlist Genre label filter; shown when provided and labels exist */
  genreFilter?: GenreFilterControl;
}

export default function LibraryControls({
  activeTab,
  query,
  onQueryChange,
  viewMode,
  onViewModeChange,
  onCreatePlaylist,
  genreFilter,
}: LibraryControlsProps) {
  const { t } = useTranslation();

  // Romanization (name display aid) toggle. It lives on the Library header
  // this wave because Settings is out of scope; its future home is a
  // Settings display/appearance row. t() returns the key itself for a
  // missing entry, so the fallback compares against the key.
  const romanizationEnabled = useRomanizationStore((state) => state.enabled);
  const setRomanizationEnabled = useRomanizationStore(
    (state) => state.setEnabled,
  );
  const romanizationKey = "library.romanization_toggle";
  const romanizationTranslated = t(romanizationKey);
  const romanizationLabel =
    romanizationTranslated === romanizationKey
      ? "Romanization"
      : romanizationTranslated;

  const placeholderByTab: Record<LibraryTab, string> = {
    all: t("library.search_all"),
    playlists: t("library.search_playlists"),
    albums: t("library.search_albums"),
    artists: t("library.search_artists"),
  };

  const iconButtonClass = `${HERO_BUTTON_CLASS} ${HERO_GLASS_BUTTON_CLASS} !w-[52px] !p-0 text-text-primary`;

  return (
    <div className="flex flex-wrap items-center gap-[8px]">
      <div
        role="search"
        data-no-window-drag
        className={`flex h-[32px] w-[220px] items-center gap-[8px] rounded-[9px] px-[10px] text-text-primary ${HERO_GLASS_CLASS}`}
      >
        <Search2Line size={16} className="shrink-0 text-text-secondary" />
        <input
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholderByTab[activeTab]}
          aria-label={placeholderByTab[activeTab]}
          spellCheck={false}
          autoComplete="off"
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              onQueryChange("");
            }
          }}
          className="h-[32px] min-w-0 flex-1 border-none bg-transparent p-0 text-label leading-[32px] font-[400] text-text-primary outline-none placeholder:text-text-secondary"
        />
        {query.length > 0 && (
          <button
            type="button"
            aria-label={t("track_search.clear")}
            data-no-tooltip="true"
            onClick={() => onQueryChange("")}
            className="-mr-[2px] flex shrink-0 items-center justify-center border-none bg-transparent p-0 cursor-pointer text-text-tertiary transition-colors hover:text-text-primary"
          >
            <CloseLine size={16} />
          </button>
        )}
      </div>

      <Button
        variant="secondary"
        data-no-tooltip="true"
        aria-label={t("library.view_grid")}
        aria-pressed={viewMode === "grid"}
        onClick={() => onViewModeChange("grid")}
        className={`${iconButtonClass} ${
          viewMode === "grid"
            ? ""
            : "!text-text-tertiary hover:!text-text-primary"
        }`}
      >
        {viewMode === "grid" ? <GridFill size={16} /> : <GridLine size={16} />}
      </Button>
      <Button
        variant="secondary"
        data-no-tooltip="true"
        aria-label={t("library.view_list")}
        aria-pressed={viewMode === "list"}
        onClick={() => onViewModeChange("list")}
        className={`${iconButtonClass} ${
          viewMode === "list"
            ? ""
            : "!text-text-tertiary hover:!text-text-primary"
        }`}
      >
        {viewMode === "list" ? (
          <ListCheckFill size={16} />
        ) : (
          <ListCheckLine size={16} />
        )}
      </Button>
      <div
        className="flex items-center gap-[8px]"
        data-no-window-drag
        title={romanizationLabel}
      >
        <span className="text-label text-text-secondary select-none">
          {romanizationLabel}
        </span>
        <ToggleSwitch
          checked={romanizationEnabled}
          onChange={setRomanizationEnabled}
          ariaLabel={romanizationLabel}
        />
      </div>
      {onCreatePlaylist && (
        <Button
          variant="primary"
          onClick={onCreatePlaylist}
          className={`${HERO_BUTTON_CLASS} px-[16px]`}
          title={t("library.create_playlist")}
        >
          <AddLine size={16} />
          <span>{t("library.create_playlist")}</span>
        </Button>
      )}
      {genreFilter && genreFilter.labels.length > 0 ? (
        <div
          role="group"
          aria-label={t("genres.filter_by_label")}
          className="flex basis-full flex-wrap items-center gap-[6px]"
        >
          {genreFilter.labels.map((label) => {
            const active = genreFilter.selected.includes(label);
            return (
              <button
                key={label}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  genreFilter.onChange(
                    active
                      ? genreFilter.selected.filter(
                          (selected) => selected !== label,
                        )
                      : [...genreFilter.selected, label],
                  )
                }
                className={`inline-flex h-[26px] cursor-pointer items-center rounded-[9px] px-[11px] text-caption font-[400] select-none transition-colors ${
                  active
                    ? "border-0 bg-btn-primary-bg text-btn-primary-text"
                    : `border-0 text-text-primary ${HERO_GLASS_CLASS} hover:bg-black/[0.09] dark:hover:bg-white/[0.16]`
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
