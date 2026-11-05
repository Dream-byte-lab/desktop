import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import ArtistPage from "./ArtistPage";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Component tests for the recomposed artist page (the user's
// artist-profile reference). Fixtures are shaped like the REAL
// view model (useArtist's ArtistPageData, client Tracks): the full
// fixture carries every field the catalogue can supply; the sparse
// fixture carries none of the optional ones, proving the reference
// elements with no data behind them render as clean omissions.

vi.mock("@/languages", async () => {
  const en = (await import("@/languages/locales/en.json")).default;
  const t = (key: string, vars?: Record<string, unknown>): string => {
    let node: any = en;
    for (const part of key.split(".")) node = node?.[part];
    if (typeof node !== "string") return key;
    return node.replace(/\{(\w+)\}/g, (_, name: string) =>
      vars && name in vars ? String(vars[name]) : `{${name}}`,
    );
  };
  return {
    useTranslation: () => ({ t, locale: "en", setLocale: () => {} }),
  };
});

const hookState = vi.hoisted(() => ({
  artist: { data: null as any, loading: false },
  appearances: [] as any[],
  savedArtists: [] as any[],
  likedTracks: [] as any[],
  openAddToLibrary: vi.fn(),
  openRemoveFromLibrary: vi.fn(),
  playTrack: vi.fn(),
  playShuffled: vi.fn(),
  clearQueue: vi.fn(),
}));

vi.mock("../hooks/useArtist", () => ({
  useArtist: () => hookState.artist,
}));

vi.mock("../hooks/useArtistAppearances", () => ({
  useArtistAppearances: () => ({
    data: hookState.appearances,
    loading: false,
  }),
}));

vi.mock("../hooks/useArtistAvatar", () => ({
  useArtistAvatar: () => null,
}));

vi.mock("@/features/library/hooks", () => ({
  useExternalItems: () => ({ data: hookState.savedArtists }),
  useLikedTracks: () => ({
    data: {
      tracks: hookState.likedTracks,
      total: hookState.likedTracks.length,
    },
    isLoading: false,
  }),
}));

vi.mock("@/features/library", () => ({
  useModalStore: Object.assign(() => ({}), {
    getState: () => ({
      openAddToLibrary: hookState.openAddToLibrary,
      openRemoveFromLibrary: hookState.openRemoveFromLibrary,
    }),
  }),
}));

vi.mock("@/features/player", () => ({
  playerEngine: {
    playTrack: hookState.playTrack,
    playShuffled: hookState.playShuffled,
    clearQueue: hookState.clearQueue,
  },
}));

vi.mock("@/shared/ui", () => ({
  useToast: () => ({ toast: vi.fn() }),
  HERO_BUTTON_CLASS: "hero-btn",
  HERO_GLASS_BUTTON_CLASS: "hero-glass",
}));

vi.mock("@/features/covers/lib/coverArt", () => ({
  preloadCoverArt: () => Promise.resolve(),
}));

vi.mock("@/features/covers/ui/CoverImage", () => ({
  default: ({ src, alt }: any) => (
    <span data-cover-src={src} data-cover-alt={alt} />
  ),
}));

vi.mock("@/features/player/ui/SongCardWithMenu", () => ({
  default: ({ title, trackNumber, playCount, onPlay }: any) => (
    <div data-song-row={title} data-track-number={trackNumber}>
      <span>{title}</span>
      {playCount ? <span>{playCount}</span> : null}
      <button type="button" data-play-row={title} onClick={onPlay}>
        play
      </button>
    </div>
  ),
}));

vi.mock("@/features/collection/ui/AlbumCard", () => ({
  default: ({ title, year }: any) => (
    <div data-album-card={title}>
      {title}
      {year ? ` ${year}` : ""}
    </div>
  ),
}));

vi.mock("@/features/collection/ui/ReleaseCard", () => ({
  default: ({ title }: any) => <div data-release-card={title}>{title}</div>,
}));

vi.mock("./ArtistProfileModal", () => ({
  default: () => null,
}));

function makeTrack(i: number, extra: Record<string, unknown> = {}) {
  return {
    id: `trk-${i}`,
    title: `Song ${i}`,
    artists: "Fred Again..",
    artistId: "art-1",
    artistList: [{ id: "art-1", name: "Fred Again.." }],
    coverUrl: "https://img.example/track.jpg",
    durationMs: 222000,
    playCount: 0,
    ...extra,
  };
}

const FULL_ARTIST = {
  title: "Fred Again..",
  description: "A biography in two lines.",
  coverUrl: "https://img.example/fred.jpg",
  verified: true,
  monthlyListeners: "17,682,480",
  followers: 123456,
  totalTracks: 7,
  tracks: [
    makeTrack(1, { playCount: 79243222 }),
    makeTrack(2),
    makeTrack(3),
    makeTrack(4),
    makeTrack(5),
    makeTrack(6),
    makeTrack(7),
  ],
  popularSongs: [],
  albums: [
    {
      id: "alb-1",
      title: "USB",
      coverUrl: "https://img.example/usb.jpg",
      releaseDate: "2022",
      totalTracks: 10,
    },
  ],
  singles: [
    {
      id: "sgl-1",
      title: "Stayinit",
      coverUrl: "https://img.example/stayinit.jpg",
      releaseType: "single",
      releaseDate: "2024",
    },
  ],
  similarArtists: [
    {
      id: "art-2",
      name: "Similar One",
      coverUrl: "https://img.example/sim1.jpg",
    },
    { id: "art-3", name: "Similar Two", coverUrl: "" },
  ],
  similarArtistsBasis: "fans",
  reposts: [],
};

const SPARSE_ARTIST = {
  title: "Obscure Act",
  description: "",
  coverUrl: "",
  verified: false,
  followers: 931,
  tracks: [makeTrack(1)],
  popularSongs: [],
  albums: [],
  singles: [],
  reposts: [],
};

describe("ArtistPage", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    hookState.artist = { data: null, loading: false };
    hookState.appearances = [];
    hookState.savedArtists = [];
    hookState.likedTracks = [];
    hookState.openAddToLibrary.mockClear();
    hookState.openRemoveFromLibrary.mockClear();
    hookState.playTrack.mockClear();
    hookState.playShuffled.mockClear();
    hookState.clearQueue.mockClear();

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

  async function renderPage() {
    act(() => {
      root?.render(
        <MemoryRouter initialEntries={["/artist?id=art-1"]}>
          <ArtistPage />
        </MemoryRouter>,
      );
    });
    await act(async () => {});
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

  function clickTab(text: string) {
    const tab = Array.from(
      container?.querySelectorAll('[role="tab"]') ?? [],
    ).find((b) => b.textContent?.trim() === text);
    if (!tab) throw new Error(`tab "${text}" not rendered`);
    act(() => {
      tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("hero: banner image, avatar, verified label, oversized name, audience line", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    await renderPage();

    const text = container?.textContent ?? "";
    expect(text).toContain("Fred Again..");
    expect(text).toContain("Verified Artist");
    expect(text).toContain("17,682,480 monthly audience");
    // The one artist image the API carries serves as both the
    // banner raster and the circular avatar.
    const covers = container?.querySelectorAll(
      '[data-cover-src="https://img.example/fred.jpg"]',
    );
    expect(covers?.length).toBe(2);
    const heading = container?.querySelector("h1");
    expect(heading?.textContent).toBe("Fred Again..");
  });

  it("popular: numbered rows, and a play count only where the source supplied one", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    await renderPage();

    const firstRow = container?.querySelector('[data-song-row="Song 1"]');
    expect(firstRow?.getAttribute("data-track-number")).toBe("1");
    expect(firstRow?.textContent).toContain("79,243,222");
    const secondRow = container?.querySelector('[data-song-row="Song 2"]');
    expect(secondRow?.getAttribute("data-track-number")).toBe("2");
    // Song 2's fixture has playCount 0 — the mapper leaves the
    // field un-supplied at zero, so no count renders for it.
    expect(secondRow?.textContent).not.toContain("0,000");
    // Only the first five render until "Show all".
    expect(container?.querySelector('[data-song-row="Song 6"]')).toBeNull();
    clickButton("Show all");
    expect(container?.querySelector('[data-song-row="Song 6"]')).not.toBeNull();
  });

  it("row play and the hero play disc ride the existing playback path", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    await renderPage();

    const rowPlay = container?.querySelector('[data-play-row="Song 2"]');
    act(() => {
      rowPlay?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(hookState.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: "trk-2" }),
      FULL_ARTIST.tracks,
      "Fred Again..",
      "https://img.example/fred.jpg",
    );

    const disc = container?.querySelector('button[aria-label="Play"]');
    if (!disc) throw new Error("play disc not rendered");
    act(() => {
      disc.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(hookState.clearQueue).toHaveBeenCalled();
    expect(hookState.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: "trk-1" }),
      FULL_ARTIST.tracks,
      "Fred Again..",
      "https://img.example/fred.jpg",
    );
  });

  it("the follow pill binds the real saved-artist state and modal flow", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    await renderPage();
    clickButton("Follow");
    expect(hookState.openAddToLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ id: "art-1", type: "artist" }),
    );
  });

  it("a saved artist reads Following and toggles through the remove flow", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    hookState.savedArtists = [{ id: "art-1" }];
    await renderPage();
    clickButton("Following");
    expect(hookState.openRemoveFromLibrary).toHaveBeenCalledWith(
      expect.objectContaining({ id: "art-1", type: "artist" }),
    );
  });

  it("tabs mount only where data exists: discography grid and about", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    await renderPage();

    const tabLabels = Array.from(
      container?.querySelectorAll('[role="tab"]') ?? [],
    ).map((tab) => tab.textContent?.trim());
    expect(tabLabels).toEqual([
      "Popular Songs",
      "Discography",
      "Fans also like",
      "About",
    ]);
    // No data source exists for these anywhere in the catalogue:
    // the reference's remaining tabs never mount. Appearances are
    // empty in this fixture, so its tab stays out too.
    const allText = container?.textContent ?? "";
    expect(tabLabels).not.toContain("Appears On");
    expect(allText).not.toContain("On Tour");
    expect(allText).not.toContain("Most listened in");

    clickTab("Discography");
    expect(container?.querySelector('[data-album-card="USB"]')).not.toBeNull();
    expect(
      container?.querySelector('[data-release-card="Stayinit"]'),
    ).not.toBeNull();
    expect(container?.querySelector('[data-song-row="Song 1"]')).toBeNull();

    clickTab("About");
    expect(container?.textContent ?? "").toContain("A biography in two lines.");
  });

  it("the fans tab lists the similar artists the catalogue supplied", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    await renderPage();

    clickTab("Fans also like");
    const text = container?.textContent ?? "";
    expect(text).toContain("Similar One");
    expect(text).toContain("Similar Two");
    expect(container?.querySelector('[data-song-row="Song 1"]')).toBeNull();
  });

  it("a related-tracks derivation is labelled Similar artists, never Fans", async () => {
    hookState.artist = {
      data: { ...FULL_ARTIST, similarArtistsBasis: "related" },
      loading: false,
    };
    await renderPage();

    const tabLabels = Array.from(
      container?.querySelectorAll('[role="tab"]') ?? [],
    ).map((tab) => tab.textContent?.trim());
    expect(tabLabels).toContain("Similar artists");
    expect(tabLabels).not.toContain("Fans also like");
  });

  it("the popular tab carries the latest-release card, newest dated release", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    await renderPage();

    // The 2024 single outranks the 2022 album; derived from the
    // catalogue's own release dates and labelled as what it is.
    const text = container?.textContent ?? "";
    expect(text).toContain("Latest release");
    expect(text).toContain("Stayinit");
    expect(text).toContain("Single • 2024");
  });

  it("no dated release: no latest-release card", async () => {
    hookState.artist = {
      data: {
        ...FULL_ARTIST,
        albums: [{ ...FULL_ARTIST.albums[0], releaseDate: undefined }],
        singles: [{ ...FULL_ARTIST.singles[0], releaseDate: undefined }],
      },
      loading: false,
    };
    await renderPage();
    expect(container?.textContent ?? "").not.toContain("Latest release");
  });

  it("the Appears On tab mounts on non-lead credits and lists them", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    hookState.appearances = [
      makeTrack(201, {
        artists: "Lead Artist, Fred Again..",
        artistList: [
          { id: "art-9", name: "Lead Artist" },
          { id: "art-1", name: "Fred Again.." },
        ],
      }),
    ];
    await renderPage();

    const tabLabels = Array.from(
      container?.querySelectorAll('[role="tab"]') ?? [],
    ).map((tab) => tab.textContent?.trim());
    expect(tabLabels).toContain("Appears On");

    clickTab("Appears On");
    expect(
      container?.querySelector('[data-song-row="Song 201"]'),
    ).not.toBeNull();
  });

  it("appearances that are the artist's own tracks keep the tab out", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    hookState.appearances = [makeTrack(1)];
    await renderPage();

    const tabLabels = Array.from(
      container?.querySelectorAll('[role="tab"]') ?? [],
    ).map((tab) => tab.textContent?.trim());
    expect(tabLabels).not.toContain("Appears On");
  });

  it("the Liked Songs card counts only this artist's liked tracks and plays them", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    hookState.likedTracks = [
      makeTrack(101),
      makeTrack(102, {
        artistId: "art-9",
        artistList: [{ id: "art-9", name: "Someone Else" }],
      }),
    ];
    await renderPage();

    const text = container?.textContent ?? "";
    expect(text).toContain("Liked Songs");
    expect(text).toContain("You've liked 1 song");

    const card = Array.from(container?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent?.startsWith("Liked Songs"),
    );
    if (!card) throw new Error("liked songs card not rendered");
    act(() => {
      card.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(hookState.playTrack).toHaveBeenCalledWith(
      expect.objectContaining({ id: "trk-101" }),
      [expect.objectContaining({ id: "trk-101" })],
      "Fred Again..",
      "https://img.example/fred.jpg",
    );
  });

  it("no liked tracks by the artist: the card is omitted, not zero-filled", async () => {
    hookState.artist = { data: FULL_ARTIST, loading: false };
    await renderPage();
    expect(container?.textContent ?? "").not.toContain("Liked Songs");
  });

  it("sparse artist: followers fallback, no verified label, one tab, no counts", async () => {
    hookState.artist = { data: SPARSE_ARTIST, loading: false };
    await renderPage();

    const text = container?.textContent ?? "";
    expect(text).toContain("Obscure Act");
    expect(text).toContain("931 followers");
    expect(text).not.toContain("Verified Artist");
    const tabLabels = Array.from(
      container?.querySelectorAll('[role="tab"]') ?? [],
    ).map((tab) => tab.textContent?.trim());
    expect(tabLabels).toEqual(["Popular Songs"]);
  });

  it("a missing artist keeps the not-found state", async () => {
    hookState.artist = { data: null, loading: false };
    await renderPage();
    expect(container?.textContent ?? "").toContain("Artist not found");
  });
});
