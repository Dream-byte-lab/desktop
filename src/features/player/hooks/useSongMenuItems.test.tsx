// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";
import { useSongMenuItems, SongMenuContext } from "./useSongMenuItems";
import { showToast } from "@/shared/ui";
import { ApiError } from "@/shared/api";
import type { DropdownMenuItem } from "@/shared/ui/DropdownMenu";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  playlists: [] as Array<Record<string, unknown>>,
  mutateAsync: vi.fn(),
  openAddToPlaylist: vi.fn(),
  openRemoveFromPlaylist: vi.fn(),
}));

vi.mock("@/features/library", () => ({
  usePlaylistsList: () => ({ data: { playlists: mocks.playlists } }),
  useAddPlaylistTracks: () => ({ mutateAsync: mocks.mutateAsync }),
  useLikeTrack: () => ({ mutate: vi.fn() }),
  useUnlikeTrack: () => ({ mutate: vi.fn() }),
  useToggleTrackLike: () => vi.fn(),
  useIsTrackLiked: () => false,
  useModalStore: {
    getState: () => ({
      openAddToPlaylist: mocks.openAddToPlaylist,
      openRemoveFromPlaylist: mocks.openRemoveFromPlaylist,
      openAddToLibrary: vi.fn(),
    }),
  },
}));

vi.mock("@/languages", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        "common.start_radio": "Start station",
        "common.play_next": "Play next",
        "common.add_to_queue": "Add to queue",
        "common.like": "Like",
        "common.unlike": "Unlike",
        "common.add_to_playlist": "Add to playlist",
        "common.added_to_playlist": "Added to playlist",
        "common.track_already_in_playlist":
          "This song is already added to this playlist",
        "common.failed_add_playlist": "Failed to add to playlist",
        "common.remove_from_playlist": "Remove from playlist",
        "common.add_to_library": "Add to library",
        "common.share": "Share",
        "common.link_copied": "Link copied",
      };
      return dict[key] || key;
    },
  }),
}));

vi.mock("@/shared/ui", () => ({
  showToast: vi.fn(),
}));

describe("useSongMenuItems", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mocks.playlists = [];
    mocks.mutateAsync.mockReset();
    mocks.mutateAsync.mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
    vi.restoreAllMocks();
  });

  function renderHookHelper(ctx: SongMenuContext) {
    let result: DropdownMenuItem[] = [];
    function TestComponent() {
      result = useSongMenuItems(ctx);
      return null;
    }
    act(() => {
      root.render(<TestComponent />);
    });
    return () => result;
  }

  it("includes share item for a standard track and copies track link to clipboard", () => {
    const getResult = renderHookHelper({
      id: "track-123",
      title: "Tarde o temprano",
      artists: "Nsqk",
      coverUrl: "https://covers.tryliner.fun/test.jpg",
    });

    const items = getResult();
    const shareItem = items.find((item) => item.id === "share");
    expect(shareItem).toBeDefined();
    expect(shareItem?.label).toBe("Share");

    act(() => {
      shareItem?.onClick?.();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://link.tryliner.fun/track?id=track-123",
    );
    expect(showToast).toHaveBeenCalledWith("Link copied", "checkmark", {
      description: "Tarde o temprano — Nsqk",
    });
  });

  it("includes share item when inside a playlist with remove-from-playlist option", () => {
    const getResult = renderHookHelper({
      id: "track-456",
      title: "SANGRE !",
      artists: "Nsqk",
      coverUrl: "https://covers.tryliner.fun/test2.jpg",
      playlistId: "playlist-1",
      playlistItemId: "item-1",
    });

    const items = getResult();
    const ids = items.map((i) => i.id);
    expect(ids).toContain("share");
    expect(ids).toContain("remove-from-playlist");

    const shareItem = items.find((item) => item.id === "share");
    act(() => {
      shareItem?.onClick?.();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://link.tryliner.fun/track?id=track-456",
    );
  });

  it("includes share item for non-track entities (e.g. album)", () => {
    const getResult = renderHookHelper({
      id: "album-789",
      title: "ROY",
      artists: "Nsqk",
      coverUrl: "https://covers.tryliner.fun/album.jpg",
      searchType: "album",
    });

    const items = getResult();
    const ids = items.map((i) => i.id);
    expect(ids).toContain("add-to-library");
    expect(ids).toContain("share");

    const shareItem = items.find((item) => item.id === "share");
    act(() => {
      shareItem?.onClick?.();
    });

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "https://link.tryliner.fun/album?id=album-789",
    );
  });

  it("adds a remove-from-queue entry only for queue rows", () => {
    const onRemoveFromQueue = vi.fn();
    const entry = renderHookHelper({
      id: "t1",
      title: "Demo",
      artists: "Me",
      coverUrl: "",
      onRemoveFromQueue,
    })().find((item) => item.id === "remove-from-queue");
    expect(entry?.label).toBe("common.remove_from_queue");
    expect(entry?.danger).toBe(true);
    act(() => entry?.onClick?.());
    expect(onRemoveFromQueue).toHaveBeenCalledTimes(1);

    const elsewhere = renderHookHelper({
      id: "t1",
      title: "Demo",
      artists: "Me",
      coverUrl: "",
    })();
    expect(elsewhere.map((item) => item.id)).not.toContain("remove-from-queue");
  });

  describe("quick add-to-playlist", () => {
    const playlist = (id: string, title: string, updatedAt: string) => ({
      id,
      title,
      updatedAt,
      createdAt: updatedAt,
      trackCount: 3,
      coverUrl: "",
      coverUrls: [],
      revision: 1,
    });

    const quickItems = (items: DropdownMenuItem[]) =>
      items.filter((item) => item.id.startsWith("quick-add-to-playlist:"));

    it("shows up to 4 quick items, most recently updated first, right after the modal item", () => {
      mocks.playlists = [
        playlist("p1", "Oldest", "2026-01-01T00:00:00.000Z"),
        playlist("p2", "Newest", "2026-06-01T00:00:00.000Z"),
        playlist("p3", "Middle", "2026-03-01T00:00:00.000Z"),
        playlist("p4", "Second newest", "2026-05-01T00:00:00.000Z"),
        playlist("p5", "Second oldest", "2026-02-01T00:00:00.000Z"),
        playlist("p6", "Fourth", "2026-04-01T00:00:00.000Z"),
      ];

      const items = renderHookHelper({
        id: "track-1",
        title: "Song",
        artists: "Artist",
        coverUrl: "",
      })();

      const quick = quickItems(items);
      expect(quick.map((item) => item.label)).toEqual([
        "Newest",
        "Second newest",
        "Fourth",
        "Middle",
      ]);
      const modalIndex = items.findIndex(
        (item) => item.id === "add-to-playlist",
      );
      expect(modalIndex).toBeGreaterThanOrEqual(0);
      expect(items[modalIndex + 1]?.id).toBe(quick[0]?.id);
      expect(items[modalIndex + 4]?.id).toBe(quick[3]?.id);
    });

    it("shows no quick items when there are no playlists, but keeps the modal item", () => {
      const items = renderHookHelper({
        id: "track-1",
        title: "Song",
        artists: "Artist",
        coverUrl: "",
      })();
      expect(quickItems(items)).toHaveLength(0);
      expect(items.map((item) => item.id)).toContain("add-to-playlist");
    });

    it("shows no quick items when the track has no id", () => {
      mocks.playlists = [playlist("p1", "Mix", "2026-06-01T00:00:00.000Z")];
      const items = renderHookHelper({
        title: "Song",
        artists: "Artist",
        coverUrl: "",
      })();
      expect(quickItems(items)).toHaveLength(0);
    });

    it("clicking a quick item adds the track and toasts success naming the playlist", async () => {
      mocks.playlists = [
        playlist("p9", "Road Trip", "2026-06-01T00:00:00.000Z"),
      ];
      const items = renderHookHelper({
        id: "track-9",
        title: "Song",
        artists: "Artist",
        coverUrl: "",
      })();
      const quick = quickItems(items)[0];
      expect(quick?.label).toBe("Road Trip");

      await act(async () => {
        await quick?.onClick?.();
      });

      expect(mocks.mutateAsync).toHaveBeenCalledWith({
        playlistId: "p9",
        trackId: "track-9",
      });
      expect(showToast).toHaveBeenCalledWith("Added to playlist", "checkmark", {
        description: "Road Trip",
      });
    });

    it("toasts the already-in message on a 409", async () => {
      mocks.playlists = [
        playlist("p9", "Road Trip", "2026-06-01T00:00:00.000Z"),
      ];
      mocks.mutateAsync.mockRejectedValue(new ApiError(409, "conflict"));
      const items = renderHookHelper({
        id: "track-9",
        title: "My Song",
        artists: "Artist",
        coverUrl: "",
      })();

      await act(async () => {
        await quickItems(items)[0]?.onClick?.();
      });

      expect(showToast).toHaveBeenCalledWith(
        "This song is already added to this playlist",
        "error",
        { description: "My Song" },
      );
    });

    it("toasts the failure message on other errors", async () => {
      mocks.playlists = [
        playlist("p9", "Road Trip", "2026-06-01T00:00:00.000Z"),
      ];
      mocks.mutateAsync.mockRejectedValue(new Error("boom"));
      const items = renderHookHelper({
        id: "track-9",
        title: "My Song",
        artists: "Artist",
        coverUrl: "",
      })();

      await act(async () => {
        await quickItems(items)[0]?.onClick?.();
      });

      expect(showToast).toHaveBeenCalledWith(
        "Failed to add to playlist",
        "error",
      );
    });

    it("the modal item still opens the AddToPlaylist modal with the playlists", () => {
      mocks.playlists = [playlist("p1", "Mix", "2026-06-01T00:00:00.000Z")];
      const items = renderHookHelper({
        id: "track-1",
        title: "Song",
        artists: "Artist",
        coverUrl: "",
      })();
      const modalItem = items.find((item) => item.id === "add-to-playlist");
      act(() => {
        modalItem?.onClick?.();
      });
      expect(mocks.openAddToPlaylist).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "track-1",
          playlists: mocks.playlists,
        }),
      );
    });
  });

  describe("quick add-to-playlist in playlist context", () => {
    const playlist = (id: string, title: string, updatedAt: string) => ({
      id,
      title,
      updatedAt,
      createdAt: updatedAt,
      trackCount: 3,
      coverUrl: "",
      coverUrls: [],
      revision: 1,
    });

    const quickItems = (items: DropdownMenuItem[]) =>
      items.filter((item) => item.id.startsWith("quick-add-to-playlist:"));

    const inPlaylist = (overrides: Partial<SongMenuContext> = {}) =>
      renderHookHelper({
        id: "track-1",
        title: "Song",
        artists: "Artist",
        coverUrl: "",
        playlistId: "p-containing",
        playlistItemId: "item-1",
        playlistTitle: "Containing",
        ...overrides,
      })();

    it("shows quick items ordered by updatedAt desc, immediately before remove-from-playlist, with the modal item still absent", () => {
      mocks.playlists = [
        playlist("p-containing", "Containing", "2026-01-01T00:00:00.000Z"),
        playlist("p-old", "Old", "2026-02-01T00:00:00.000Z"),
        playlist("p-new", "New", "2026-06-01T00:00:00.000Z"),
        playlist("p-mid", "Mid", "2026-03-01T00:00:00.000Z"),
      ];

      const items = inPlaylist();
      const quick = quickItems(items);
      expect(quick.map((item) => item.label)).toEqual(["New", "Mid", "Old"]);

      const ids = items.map((item) => item.id);
      expect(ids).not.toContain("add-to-playlist");
      const removeIndex = ids.indexOf("remove-from-playlist");
      expect(removeIndex).toBeGreaterThanOrEqual(0);
      // The quick block sits immediately before remove, which stays last.
      expect(removeIndex).toBe(items.length - 1);
      expect(items[removeIndex - quick.length]?.id).toBe(quick[0]?.id);
      expect(items[removeIndex - 1]?.id).toBe(quick[quick.length - 1]?.id);
    });

    it("excludes the containing playlist and still fills the 4 slots from the next most recent", () => {
      mocks.playlists = [
        playlist("p1", "Oldest", "2026-01-01T00:00:00.000Z"),
        playlist("p-containing", "Containing", "2026-06-01T00:00:00.000Z"),
        playlist("p3", "Middle", "2026-03-01T00:00:00.000Z"),
        playlist("p4", "Second newest", "2026-05-01T00:00:00.000Z"),
        playlist("p5", "Second oldest", "2026-02-01T00:00:00.000Z"),
        playlist("p6", "Fourth", "2026-04-01T00:00:00.000Z"),
      ];

      const items = inPlaylist();
      const quick = quickItems(items);
      expect(quick.map((item) => item.id)).not.toContain(
        "quick-add-to-playlist:p-containing",
      );
      expect(quick.map((item) => item.label)).toEqual([
        "Second newest",
        "Fourth",
        "Middle",
        "Second oldest",
      ]);
    });

    it("clicking a quick item adds the track and toasts success naming the target playlist", async () => {
      mocks.playlists = [
        playlist("p-containing", "Containing", "2026-01-01T00:00:00.000Z"),
        playlist("p9", "Road Trip", "2026-06-01T00:00:00.000Z"),
      ];
      const items = inPlaylist({ id: "track-9" });
      const quick = quickItems(items)[0];
      expect(quick?.id).toBe("quick-add-to-playlist:p9");
      expect(quick?.label).toBe("Road Trip");

      await act(async () => {
        await quick?.onClick?.();
      });

      expect(mocks.mutateAsync).toHaveBeenCalledWith({
        playlistId: "p9",
        trackId: "track-9",
      });
      expect(showToast).toHaveBeenCalledWith("Added to playlist", "checkmark", {
        description: "Road Trip",
      });
    });

    it("toasts the already-in message on a 409 in playlist context", async () => {
      mocks.playlists = [
        playlist("p-containing", "Containing", "2026-01-01T00:00:00.000Z"),
        playlist("p9", "Road Trip", "2026-06-01T00:00:00.000Z"),
      ];
      mocks.mutateAsync.mockRejectedValue(new ApiError(409, "conflict"));
      const items = inPlaylist({ id: "track-9", title: "My Song" });

      await act(async () => {
        await quickItems(items)[0]?.onClick?.();
      });

      expect(showToast).toHaveBeenCalledWith(
        "This song is already added to this playlist",
        "error",
        { description: "My Song" },
      );
    });

    it("keeps remove-from-playlist present and unchanged in playlist context", () => {
      mocks.playlists = [
        playlist("p9", "Road Trip", "2026-06-01T00:00:00.000Z"),
      ];
      const items = inPlaylist();
      const removeItem = items.find(
        (item) => item.id === "remove-from-playlist",
      );
      expect(removeItem).toBeDefined();
      expect(removeItem?.label).toBe("Remove from playlist");
      expect(removeItem?.danger).toBe(true);

      act(() => {
        removeItem?.onClick?.();
      });
      expect(mocks.openRemoveFromPlaylist).toHaveBeenCalledWith(
        expect.objectContaining({
          trackId: "track-1",
          playlistItemId: "item-1",
          playlistId: "p-containing",
          playlistTitle: "Containing",
        }),
      );
    });

    it("gives a local-device track in playlist context no quick items", () => {
      mocks.playlists = [
        playlist("p9", "Road Trip", "2026-06-01T00:00:00.000Z"),
        playlist("p8", "Other Mix", "2026-05-01T00:00:00.000Z"),
      ];
      const items = inPlaylist({ id: "local:0123456789abcdef0123" });
      expect(quickItems(items)).toHaveLength(0);
      // The local filter still leaves the device-safe queue/play items.
      const ids = items.map((item) => item.id);
      expect(ids).toContain("play-next");
      expect(ids).toContain("add-to-queue");
    });
  });
});
