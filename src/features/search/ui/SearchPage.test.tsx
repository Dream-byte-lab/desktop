import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import SearchPage from "./SearchPage";
import { useSearchHistoryStore } from "../store/searchHistoryStore";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The strings the slice OWES en.json (named exactly in the build
// report's seams list). The translation mock resolves them from
// this table so the tests pin the real English; everything else
// resolves from the shipped en.json, and an unknown key renders as
// itself so a missing key can never pass silently.
const OWED_STRINGS: Record<string, string> = {
  "search.page.results_eyebrow": "Search results",
  "search.page.follow": "Follow",
  "search.page.following": "Following",
  "search.page.shuffle_play": "Shuffle Play",
  "search.page.related_artists": "Related artists",
  "search.page.genre_chips_title": "Your Playlist Genre labels",
  "search.page.clear_query": "Clear search",
  "search.page.toggle_filters": "Filter results",
  "search.page.no_results_for": "No results for “{query}”",
  "search.page.no_results_hint":
    "Check the spelling, try a different name, or clear the type filter to search everything.",
  "search.page.no_results_source":
    "Searched the Liner catalogue — the only source connected right now.",
  "search.page.search_everything": "Search everything",
  "search.page.error_title": "Search didn't go through",
  "search.page.error_hint":
    "Something went wrong while searching. Check your connection and try again.",
  "search.page.retry": "Try again",
  "search.page.offline_title": "You're offline",
  "search.page.offline_hint":
    "Search needs a connection. Your downloads and local music are still here.",
};

vi.mock("@/languages", async () => {
  const en = (await import("@/languages/locales/en.json")).default;
  const t = (key: string, vars?: Record<string, unknown>): string => {
    let text: string | undefined = OWED_STRINGS[key];
    if (text === undefined) {
      let node: any = en;
      for (const part of key.split(".")) node = node?.[part];
      if (typeof node === "string") text = node;
    }
    if (text === undefined) return key;
    return text.replace(/\{(\w+)\}/g, (_, name: string) =>
      vars && name in vars ? String(vars[name]) : `{${name}}`,
    );
  };
  return {
    useTranslation: () => ({ t, locale: "en", setLocale: () => {} }),
  };
});

const hookState = vi.hoisted(() => ({
  all: {
    items: [] as any[],
    loading: false,
    hasLoaded: false,
    error: null as Error | null,
    partialWarning: undefined as string | undefined,
    runNow: vi.fn(),
  },
  tracks: {
    tracks: [] as any[],
    loading: false,
    hasLoaded: false,
    error: null as Error | null,
    partialWarning: undefined as string | undefined,
    runNow: vi.fn(),
  },
  artists: {
    artists: [] as any[],
    loading: false,
    hasLoaded: false,
    error: null as Error | null,
    partialWarning: undefined as string | undefined,
    runNow: vi.fn(),
  },
  albums: {
    albums: [] as any[],
    loading: false,
    hasLoaded: false,
    error: null as Error | null,
    partialWarning: undefined as string | undefined,
    runNow: vi.fn(),
  },
  playlists: {
    playlists: [] as any[],
    loading: false,
    hasLoaded: false,
    error: null as Error | null,
    partialWarning: undefined as string | undefined,
    runNow: vi.fn(),
  },
  artistPage: {
    data: null as any,
    loading: false,
  },
  offline: false,
  genreLabels: [] as string[],
}));

vi.mock("../hooks/useSearchAll", () => ({
  useSearchAll: () => hookState.all,
}));
vi.mock("../hooks/useSearchTracks", () => ({
  useSearchTracks: () => hookState.tracks,
}));
vi.mock("../hooks/useSearchArtists", () => ({
  useSearchArtists: () => hookState.artists,
}));
vi.mock("../hooks/useSearchAlbums", () => ({
  useSearchAlbums: () => hookState.albums,
}));
vi.mock("../hooks/useSearchPlaylists", () => ({
  useSearchPlaylists: () => hookState.playlists,
}));

vi.mock("@/features/artist/hooks/useArtist", () => ({
  useArtist: () => hookState.artistPage,
}));

vi.mock("@/features/library/hooks/useExternalItems", () => ({
  useExternalItems: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/features/library/store/modalStore", () => ({
  useModalStore: Object.assign(() => ({}), {
    getState: () => ({
      openAddToLibrary: vi.fn(),
      openRemoveFromLibrary: vi.fn(),
    }),
  }),
}));

vi.mock("@/features/connectivity", () => ({
  useOfflineModeStore: (selector: any) =>
    selector({ offline: hookState.offline }),
}));

vi.mock("@/features/genres/playlistGenreStore", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useAllInUseGenreLabels: () => hookState.genreLabels,
  };
});

vi.mock("@/features/player", () => ({
  playerEngine: {
    primeUserGesture: vi.fn(),
    playTrack: vi.fn(),
    clearQueue: vi.fn(),
    playShuffled: vi.fn(),
  },
}));

vi.mock("@/features/player/ui/SongCardWithMenu", () => ({
  default: ({ title, onPlay }: any) => (
    <button type="button" data-song-row={title} onClick={onPlay}>
      {title}
    </button>
  ),
}));

vi.mock("@/features/covers/ui/CoverImage", () => ({
  default: ({ alt }: any) => <span data-cover-alt={alt} />,
}));

vi.mock("@/features/collection/ui/AlbumCard", () => ({
  default: ({ title, year }: any) => (
    <div data-album-card={title}>
      {title}
      {year ? ` ${year}` : ""}
    </div>
  ),
}));

vi.mock("@/features/library/ui/PlaylistCard", () => ({
  default: ({ title, author }: any) => (
    <div data-playlist-card={title}>
      {title} {author}
    </div>
  ),
}));

const TRACK_ITEM = {
  type: "track",
  id: "trk-1",
  title: "Waterloo",
  artists: [{ id: "art-1", name: "ABBA" }],
  durationMs: 169000,
  cover: { url: "https://img.example/waterloo.jpg" },
};
const ARTIST_ITEM = {
  type: "artist",
  id: "art-1",
  name: "ABBA",
  cover: { url: "https://img.example/abba.jpg" },
};
const ARTIST_ITEM_2 = {
  type: "artist",
  id: "art-2",
  name: "Abba Tribute Band",
  cover: { url: "https://img.example/tribute.jpg" },
};
const ALBUM_ITEM = {
  type: "album",
  id: "alb-1",
  title: "Waterloo (Album)",
  artists: [{ id: "art-1", name: "ABBA" }],
  year: 1974,
  cover: { url: "https://img.example/album.jpg" },
};
const PLAYLIST_ITEM = {
  type: "playlist",
  id: "pl-1",
  title: "ABBA Gold Mix",
  author: "liner",
  cover: { url: "https://img.example/pl.jpg" },
};

describe("SearchPage", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
    useSearchHistoryStore.setState({ items: [] });
    hookState.all = {
      items: [],
      loading: false,
      hasLoaded: false,
      error: null,
      partialWarning: undefined,
      runNow: vi.fn(),
    };
    hookState.tracks = {
      tracks: [],
      loading: false,
      hasLoaded: false,
      error: null,
      partialWarning: undefined,
      runNow: vi.fn(),
    };
    hookState.artists = {
      artists: [],
      loading: false,
      hasLoaded: false,
      error: null,
      partialWarning: undefined,
      runNow: vi.fn(),
    };
    hookState.albums = {
      albums: [],
      loading: false,
      hasLoaded: false,
      error: null,
      partialWarning: undefined,
      runNow: vi.fn(),
    };
    hookState.playlists = {
      playlists: [],
      loading: false,
      hasLoaded: false,
      error: null,
      partialWarning: undefined,
      runNow: vi.fn(),
    };
    hookState.artistPage = { data: null, loading: false };
    hookState.offline = false;
    hookState.genreLabels = [];

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
  });

  function renderPage(entry = "/search") {
    act(() => {
      root?.render(
        <MemoryRouter initialEntries={[entry]}>
          <SearchPage />
        </MemoryRouter>,
      );
    });
  }

  function typeQuery(value: string) {
    const input = container?.querySelector("input");
    if (!input) throw new Error("query input not rendered");
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(input),
      "value",
    )?.set;
    act(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function clickButton(text: string) {
    const button = Array.from(container?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent?.trim() === text,
    );
    if (!button) throw new Error(`button "${text}" not rendered`);
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("before typing: renders recents + the listener's own Playlist Genre chips, and no trending block", () => {
    act(() => {
      useSearchHistoryStore.setState({
        items: [
          {
            id: "query:abba",
            type: "query",
            title: "abba",
            timestamp: Date.now(),
          },
        ],
      });
    });
    hookState.genreLabels = ["Jazz Vibes", "Gym"];
    renderPage();

    const text = container?.textContent ?? "";
    expect(text).toContain("Recent searches");
    expect(text).toContain("abba");
    expect(text).toContain("Your Playlist Genre labels");
    expect(text).toContain("Jazz Vibes");
    expect(text).toContain("Gym");
    // No trending searches exist to show: nothing is dressed up as one.
    expect(text.toLowerCase()).not.toContain("trending");
  });

  it("a Playlist Genre chip runs the label as a catalogue search", () => {
    hookState.genreLabels = ["Jazz Vibes"];
    renderPage();
    clickButton("Jazz Vibes");
    const input = container?.querySelector("input");
    expect(input?.value).toBe("Jazz Vibes");
  });

  it("a query renders all four blocks from useSearchAll", () => {
    hookState.all.items = [
      TRACK_ITEM,
      ARTIST_ITEM,
      ARTIST_ITEM_2,
      ALBUM_ITEM,
      PLAYLIST_ITEM,
    ];
    hookState.all.hasLoaded = true;
    hookState.artistPage.data = {
      title: "ABBA",
      tracks: [{ id: "trk-1" }],
      verified: true,
      coverUrl: "",
      description: "",
    };
    renderPage();
    typeQuery("abba");

    const text = container?.textContent ?? "";
    expect(text).toContain("Search results");
    expect(text).toContain("Songs");
    expect(text).toContain("Waterloo");
    expect(text).toContain("Artists");
    expect(text).toContain("ABBA");
    expect(text).toContain("Related artists");
    expect(text).toContain("Abba Tribute Band");
    expect(text).toContain("Albums");
    expect(text).toContain("Waterloo (Album)");
    expect(text).toContain("Playlists");
    expect(text).toContain("ABBA Gold Mix");
  });

  it("the hero renders WITHOUT a stat line — the register's absence is pinned", () => {
    hookState.all.items = [ARTIST_ITEM];
    hookState.all.hasLoaded = true;
    hookState.artistPage.data = {
      title: "ABBA",
      tracks: [{ id: "trk-1" }],
      verified: false,
      coverUrl: "",
      description: "",
      monthlyListeners: "7,847,659",
      followers: 1234567,
    };
    renderPage();
    typeQuery("abba");

    const text = container?.textContent ?? "";
    expect(text).toContain("ABBA");
    expect(text).toContain("Follow");
    expect(text).toContain("Shuffle Play");
    expect(text).not.toContain("7,847,659");
    expect(text.toLowerCase()).not.toContain("monthly listeners");
    expect(text).not.toContain("1,234,567");
  });

  it("the type chip scopes the page to the per-type hook", () => {
    hookState.all.items = [TRACK_ITEM, ALBUM_ITEM];
    hookState.all.hasLoaded = true;
    hookState.tracks.tracks = [
      {
        id: "trk-9",
        title: "Scoped Song",
        artists: "ABBA",
        coverUrl: "",
        durationMs: 1000,
      } as any,
    ];
    hookState.tracks.hasLoaded = true;
    renderPage();
    typeQuery("abba");

    // Open the chip row via the filter button, then choose Songs.
    const filterButton = container?.querySelector(
      'button[aria-label="Filter results"]',
    );
    if (!filterButton) throw new Error("filter button not rendered");
    act(() => {
      filterButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    clickButton("Songs");

    const text = container?.textContent ?? "";
    expect(text).toContain("Scoped Song");
    expect(text).not.toContain("Waterloo (Album)");
    expect(container?.querySelector("[data-album-card]")).toBeNull();
  });

  it("failure renders a retry state that is distinct from no-results", () => {
    hookState.all.hasLoaded = true;
    hookState.all.error = new Error("network down");
    renderPage();
    typeQuery("abba");

    const text = container?.textContent ?? "";
    expect(text).toContain("Search didn't go through");
    expect(text).not.toContain("No results for");

    clickButton("Try again");
    expect(hookState.all.runNow).toHaveBeenCalled();
  });

  it("no results renders the widen-guidance state, not the failure state", () => {
    hookState.all.hasLoaded = true;
    hookState.all.error = null;
    hookState.all.items = [];
    renderPage();
    typeQuery("abba");

    const text = container?.textContent ?? "";
    expect(text).toContain("No results for “abba”");
    expect(text).toContain("Check the spelling");
    expect(text).toContain("Liner catalogue");
    expect(text).not.toContain("Search didn't go through");
  });

  it("offline renders the door state to the local shelves", () => {
    hookState.offline = true;
    renderPage();

    const text = container?.textContent ?? "";
    expect(text).toContain("You're offline");
    expect(text).toContain("Search needs a connection");
    expect(
      container?.querySelector('a[href="/library/cached"]'),
    ).not.toBeNull();
    expect(container?.querySelector('a[href="/library"]')).not.toBeNull();
    expect(text).not.toContain("Search results");
  });

  it("a query carried in the URL (the sidebar quick door) is adopted", () => {
    hookState.all.items = [TRACK_ITEM];
    hookState.all.hasLoaded = true;
    renderPage("/search?q=abba");

    const input = container?.querySelector("input");
    expect(input?.value).toBe("abba");
    expect(container?.textContent ?? "").toContain("Waterloo");
  });
});
