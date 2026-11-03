// @vitest-environment jsdom
import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { useExternalItems, type EntityType } from "./useExternalItems";
import { api } from "@/shared/api";
import { clearScreenCache } from "@/shared/cache/screenCache";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/shared/api", () => ({
  api: {
    listSavedCollections: vi.fn(),
    getAlbum: vi.fn(),
    getArtist: vi.fn(),
  },
  mediaUrl: (url: string) => url,
  toMaxQualityAvatarUrl: (url: string) => (url ? `${url}#max` : url),
  getAuthSession: () => (globalThis as any).__testAuthSession ?? null,
}));

const artistsResponse = {
  items: [
    {
      savedAt: "2026-10-20T10:00:00.000Z",
      artist: { id: "a1", name: "SZA", cover: { url: "sza.jpg" } },
    },
  ],
};

let latest: ReturnType<typeof useExternalItems> | null = null;

function Probe() {
  latest = useExternalItems("artist");
  return null;
}

function TypedProbe({ type }: { type: EntityType }) {
  latest = useExternalItems(type);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("useExternalItems", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    (globalThis as any).__testAuthSession = null;
    clearScreenCache();
    vi.clearAllMocks();
    vi.mocked(api.listSavedCollections).mockResolvedValue(
      artistsResponse as any,
    );
    vi.mocked(api.getAlbum).mockRejectedValue(new Error("not mocked"));
    vi.mocked(api.getArtist).mockRejectedValue(new Error("not mocked"));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = null;
    (globalThis as any).__testAuthSession = null;
    clearScreenCache();
  });

  it("reports loading until saved artists arrive, then serves them instantly on the next open", async () => {
    await act(async () => {
      root.render(<Probe />);
    });
    expect(latest?.isLoading).toBe(false);
    expect(latest?.data.map((item) => item.title)).toEqual(["SZA"]);

    act(() => root.unmount());
    root = createRoot(container);
    vi.mocked(api.listSavedCollections).mockReturnValue(
      new Promise(() => undefined),
    );

    act(() => {
      root.render(<Probe />);
    });
    expect(latest?.isLoading).toBe(false);
    expect(latest?.data.map((item) => item.title)).toEqual(["SZA"]);
  });

  it("hydrates a sparse saved album by its own id, preserving saved fields", async () => {
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [
        {
          savedAt: "2026-10-21T09:00:00.000Z",
          album: { id: "al1", trackCount: 7 },
        },
      ],
    } as any);
    vi.mocked(api.getAlbum).mockResolvedValue({
      type: "album",
      id: "al1",
      title: "Resolved Album",
      cover: { url: "album.jpg" },
      trackCount: 99,
      year: 1999,
      artists: [],
      tracks: [],
    } as any);

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });

    expect(api.getAlbum).toHaveBeenCalledTimes(1);
    expect(api.getAlbum).toHaveBeenCalledWith("al1");
    expect(api.getArtist).not.toHaveBeenCalled();
    const item = latest?.data[0];
    expect(item?.title).toBe("Resolved Album");
    expect(item?.imageUrl).toBe("album.jpg");
    // Saved-identity fields survive: the detail response must not
    // overwrite addedAt, trackCount, href or the summary subtitle.
    expect(item?.addedAt).toBe("2026-10-21T09:00:00.000Z");
    expect(item?.trackCount).toBe(7);
    expect(item?.href).toBe("/collection?type=album&id=al1");
    expect(item?.subtitle).toBe("7 tracks");
    expect(item?.id).toBe("al1");
  });

  it("hydrates a sparse saved artist, applying the avatar transform", async () => {
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [{ savedAt: "2026-10-22T09:00:00.000Z", artist: { id: "ar1" } }],
    } as any);
    vi.mocked(api.getArtist).mockResolvedValue({
      type: "artist",
      id: "ar1",
      name: "Resolved Artist",
      cover: { url: "artist.jpg" },
      verified: false,
      tracks: [],
      albums: [],
      singles: [],
    } as any);

    await act(async () => {
      root.render(<TypedProbe type="artist" />);
    });

    expect(api.getArtist).toHaveBeenCalledTimes(1);
    expect(api.getArtist).toHaveBeenCalledWith("ar1");
    expect(api.getAlbum).not.toHaveBeenCalled();
    const item = latest?.data[0];
    expect(item?.title).toBe("Resolved Artist");
    expect(item?.imageUrl).toBe("artist.jpg#max");
    expect(item?.addedAt).toBe("2026-10-22T09:00:00.000Z");
    expect(item?.href).toBe("/artist?id=ar1");
    expect(item?.subtitle).toBe("Artist");
  });

  it("makes no catalog call for a complete summary", async () => {
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [
        {
          savedAt: "2026-10-21T09:00:00.000Z",
          album: {
            id: "al9",
            title: "Complete Album",
            cover: { url: "complete.jpg" },
          },
        },
      ],
    } as any);

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });
    await flush();

    expect(api.getAlbum).not.toHaveBeenCalled();
    expect(api.getArtist).not.toHaveBeenCalled();
    expect(latest?.data[0]?.title).toBe("Complete Album");
    expect(latest?.data[0]?.imageUrl).toBe("complete.jpg");
  });

  it("never hydrates playlists, even sparse ones", async () => {
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [{ savedAt: "2026-10-21T09:00:00.000Z", playlist: { id: "p1" } }],
    } as any);

    await act(async () => {
      root.render(<TypedProbe type="playlist" />);
    });
    await flush();

    expect(api.getAlbum).not.toHaveBeenCalled();
    expect(api.getArtist).not.toHaveBeenCalled();
    expect(latest?.data[0]?.id).toBe("p1");
    expect(latest?.data[0]?.href).toBe("/collection?type=playlist&id=p1");
  });

  it("keeps the summary exactly as-is when the lookup fails", async () => {
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [
        {
          savedAt: "2026-10-21T09:00:00.000Z",
          album: { id: "al1", trackCount: 7 },
        },
      ],
    } as any);
    vi.mocked(api.getAlbum).mockRejectedValue(new Error("catalog down"));

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });
    await flush();

    expect(api.getAlbum).toHaveBeenCalledTimes(1);
    expect(latest?.data).toEqual([
      {
        id: "al1",
        title: undefined,
        subtitle: "7 tracks",
        imageUrl: "",
        kind: "album",
        href: "/collection?type=album&id=al1",
        addedAt: "2026-10-21T09:00:00.000Z",
        trackCount: 7,
        isOwned: false,
      },
    ]);
  });

  it("discards a lookup whose id does not match the saved entry", async () => {
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [{ savedAt: "2026-10-21T09:00:00.000Z", album: { id: "al1" } }],
    } as any);
    vi.mocked(api.getAlbum).mockResolvedValue({
      type: "album",
      id: "someone-else",
      title: "Wrong Album",
      cover: { url: "wrong.jpg" },
      artists: [],
      tracks: [],
    } as any);

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });
    await flush();

    expect(api.getAlbum).toHaveBeenCalledTimes(1);
    expect(latest?.data[0]?.title).toBeUndefined();
    expect(latest?.data[0]?.imageUrl).toBe("");
  });

  it("shows summaries immediately, before hydration resolves", async () => {
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [{ savedAt: "2026-10-21T09:00:00.000Z", album: { id: "al1" } }],
    } as any);
    const pending = deferred<any>();
    vi.mocked(api.getAlbum).mockReturnValue(pending.promise);

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });

    // The saved entry is already listed (sparse) while the catalog
    // lookup is still in flight.
    expect(api.getAlbum).toHaveBeenCalledTimes(1);
    expect(latest?.isLoading).toBe(false);
    expect(latest?.data).toHaveLength(1);
    expect(latest?.data[0]?.id).toBe("al1");
    expect(latest?.data[0]?.title).toBeUndefined();
    expect(latest?.data[0]?.href).toBe("/collection?type=album&id=al1");

    await act(async () => {
      pending.resolve({
        type: "album",
        id: "al1",
        title: "Late Album",
        cover: { url: "late.jpg" },
        artists: [],
        tracks: [],
      });
    });
    expect(latest?.data[0]?.title).toBe("Late Album");
    expect(latest?.data[0]?.imageUrl).toBe("late.jpg");
  });

  it("drops a stale hydration when the list refresh removes the item", async () => {
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [{ savedAt: "2026-10-21T09:00:00.000Z", album: { id: "al1" } }],
    } as any);
    const pending = deferred<any>();
    vi.mocked(api.getAlbum).mockReturnValue(pending.promise);

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });
    expect(api.getAlbum).toHaveBeenCalledTimes(1);

    // The saved list changes underneath the in-flight lookup.
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [
        {
          savedAt: "2026-10-23T09:00:00.000Z",
          album: {
            id: "al2",
            title: "Other Album",
            cover: { url: "other.jpg" },
          },
        },
      ],
    } as any);
    await act(async () => {
      window.dispatchEvent(new Event("library:changed"));
    });
    expect(latest?.data.map((item) => item.id)).toEqual(["al2"]);

    await act(async () => {
      pending.resolve({
        type: "album",
        id: "al1",
        title: "Stale Album",
        cover: { url: "stale.jpg" },
        artists: [],
        tracks: [],
      });
    });
    await flush();

    expect(latest?.data).toHaveLength(1);
    expect(latest?.data[0]?.id).toBe("al2");
    expect(latest?.data[0]?.title).toBe("Other Album");
    expect(latest?.data[0]?.imageUrl).toBe("other.jpg");
  });

  it("drops a stale hydration when the type changes before it lands", async () => {
    vi.mocked(api.listSavedCollections).mockImplementation(
      async (collectionType: string) =>
        collectionType === "albums"
          ? {
              items: [
                { savedAt: "2026-10-21T09:00:00.000Z", album: { id: "al1" } },
              ],
            }
          : artistsResponse,
    );
    const pending = deferred<any>();
    vi.mocked(api.getAlbum).mockReturnValue(pending.promise);

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });
    expect(api.getAlbum).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(<TypedProbe type="artist" />);
    });
    expect(latest?.data.map((item) => item.title)).toEqual(["SZA"]);

    await act(async () => {
      pending.resolve({
        type: "album",
        id: "al1",
        title: "Stale Album",
        cover: { url: "stale.jpg" },
        artists: [],
        tracks: [],
      });
    });
    await flush();

    expect(latest?.data.map((item) => item.title)).toEqual(["SZA"]);
    expect(latest?.data[0]?.imageUrl).toBe("sza.jpg#max");
  });

  it("retains hydration across a library:changed refresh without duplicate calls", async () => {
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [{ savedAt: "2026-10-21T09:00:00.000Z", album: { id: "al1" } }],
    } as any);
    vi.mocked(api.getAlbum).mockResolvedValue({
      type: "album",
      id: "al1",
      title: "Resolved Album",
      cover: { url: "album.jpg" },
      artists: [],
      tracks: [],
    } as any);

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });
    expect(latest?.data[0]?.title).toBe("Resolved Album");
    expect(api.getAlbum).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("library:changed"));
    });
    await flush();

    expect(api.getAlbum).toHaveBeenCalledTimes(1);
    expect(latest?.data[0]?.title).toBe("Resolved Album");
    expect(latest?.data[0]?.imageUrl).toBe("album.jpg");
  });

  it("does not let a stale lookup overwrite a refreshed complete summary", async () => {
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [{ savedAt: "2026-10-21T09:00:00.000Z", album: { id: "al1" } }],
    } as any);
    const pending = deferred<any>();
    vi.mocked(api.getAlbum).mockReturnValue(pending.promise);

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });
    expect(api.getAlbum).toHaveBeenCalledTimes(1);

    // The refresh returns the same id, now with a complete summary of
    // its own, while the earlier lookup is still in flight.
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [
        {
          savedAt: "2026-10-21T09:00:00.000Z",
          album: {
            id: "al1",
            title: "Refreshed Album",
            cover: { url: "refreshed.jpg" },
          },
        },
      ],
    } as any);
    await act(async () => {
      window.dispatchEvent(new Event("library:changed"));
    });
    expect(latest?.data[0]?.title).toBe("Refreshed Album");

    await act(async () => {
      pending.resolve({
        type: "album",
        id: "al1",
        title: "Stale Album",
        cover: { url: "stale.jpg" },
        artists: [],
        tracks: [],
      });
    });
    await flush();

    expect(latest?.data[0]?.title).toBe("Refreshed Album");
    expect(latest?.data[0]?.imageUrl).toBe("refreshed.jpg");
  });

  it("prunes resolved details when the item leaves, so a returning item resolves fresh", async () => {
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [{ savedAt: "2026-10-21T09:00:00.000Z", album: { id: "al1" } }],
    } as any);
    vi.mocked(api.getAlbum).mockResolvedValue({
      type: "album",
      id: "al1",
      title: "Resolved Album",
      cover: { url: "album.jpg" },
      artists: [],
      tracks: [],
    } as any);

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });
    expect(latest?.data[0]?.title).toBe("Resolved Album");
    expect(api.getAlbum).toHaveBeenCalledTimes(1);

    // The item leaves the saved list.
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [
        {
          savedAt: "2026-10-23T09:00:00.000Z",
          album: {
            id: "al2",
            title: "Other Album",
            cover: { url: "other.jpg" },
          },
        },
      ],
    } as any);
    await act(async () => {
      window.dispatchEvent(new Event("library:changed"));
    });
    await flush();
    expect(latest?.data.map((item) => item.id)).toEqual(["al2"]);

    // When the same id is saved again (still sparse), its old resolved
    // details were pruned with it: it must be looked up again rather
    // than silently reusing the previous resolution.
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [{ savedAt: "2026-10-24T09:00:00.000Z", album: { id: "al1" } }],
    } as any);
    vi.mocked(api.getAlbum).mockResolvedValue({
      type: "album",
      id: "al1",
      title: "Fresh Album",
      cover: { url: "fresh.jpg" },
      artists: [],
      tracks: [],
    } as any);
    await act(async () => {
      window.dispatchEvent(new Event("library:changed"));
    });
    await flush();

    expect(api.getAlbum).toHaveBeenCalledTimes(2);
    expect(latest?.data[0]?.title).toBe("Fresh Album");
    expect(latest?.data[0]?.imageUrl).toBe("fresh.jpg");
    expect(latest?.data[0]?.addedAt).toBe("2026-10-24T09:00:00.000Z");
  });

  it("does not leak one account's hydration into another account", async () => {
    (globalThis as any).__testAuthSession = { user: { id: "user-a" } };
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: [{ savedAt: "2026-10-21T09:00:00.000Z", album: { id: "al1" } }],
    } as any);
    vi.mocked(api.getAlbum).mockResolvedValue({
      type: "album",
      id: "al1",
      title: "A's Album",
      cover: { url: "a.jpg" },
      artists: [],
      tracks: [],
    } as any);

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });
    expect(latest?.data[0]?.title).toBe("A's Album");
    expect(api.getAlbum).toHaveBeenCalledTimes(1);

    // Account switch: the same saved id must be resolved fresh for the
    // new owner, and must not flash the previous account's details.
    (globalThis as any).__testAuthSession = { user: { id: "user-b" } };
    const pending = deferred<any>();
    vi.mocked(api.getAlbum).mockReturnValue(pending.promise);
    await act(async () => {
      window.dispatchEvent(new Event("auth:changed"));
    });
    expect(api.getAlbum).toHaveBeenCalledTimes(2);
    expect(latest?.data[0]?.title).toBeUndefined();
    expect(latest?.data[0]?.imageUrl).toBe("");

    await act(async () => {
      pending.resolve({
        type: "album",
        id: "al1",
        title: "B's Album",
        cover: { url: "b.jpg" },
        artists: [],
        tracks: [],
      });
    });
    expect(latest?.data[0]?.title).toBe("B's Album");
    expect(latest?.data[0]?.imageUrl).toBe("b.jpg");
  });

  it("caps concurrent hydration lookups at four", async () => {
    const ids = ["al1", "al2", "al3", "al4", "al5", "al6"];
    vi.mocked(api.listSavedCollections).mockResolvedValue({
      items: ids.map((id) => ({
        savedAt: "2026-10-21T09:00:00.000Z",
        album: { id },
      })),
    } as any);
    let active = 0;
    let peak = 0;
    vi.mocked(api.getAlbum).mockImplementation(async (id: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return {
        type: "album",
        id,
        title: `Album ${id}`,
        cover: { url: `${id}.jpg` },
        artists: [],
        tracks: [],
      } as any;
    });

    await act(async () => {
      root.render(<TypedProbe type="album" />);
    });
    await flush(100);

    expect(api.getAlbum).toHaveBeenCalledTimes(6);
    expect(peak).toBeLessThanOrEqual(4);
    expect(latest?.data.map((item) => item.title)).toEqual(
      ids.map((id) => `Album ${id}`),
    );
  });
});
