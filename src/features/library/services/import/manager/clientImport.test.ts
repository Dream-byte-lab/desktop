import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/shared/contracts";

const mocks = vi.hoisted(() => ({
  parseImportSource: vi.fn(),
  searchRaw: vi.fn(),
}));

vi.mock("../parseImportSource", () => ({
  parseImportSource: mocks.parseImportSource,
}));
vi.mock("@/shared/youtube", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/youtube")>();
  return { ...actual, searchRaw: mocks.searchRaw };
});

import { api, ApiError } from "@/shared/api";
import {
  runClientImport,
  runClientImportFromPlaylist,
} from "./clientImportManager";
import { finalizeImportedPlaylist } from "./finalizeImport";

function searchTrack(
  id: string,
  title: string,
  artist: string,
  durationMs: number,
): SearchResult {
  return {
    type: "track",
    id,
    title,
    artists: [{ id: `UC_${artist}`, name: artist }],
    durationMs,
  };
}

const spotifyPlaylist = {
  source: "spotify" as const,
  sourceUrl: "https://open.spotify.com/playlist/abc",
  title: "Road trip",
  tracks: [
    {
      sourceId: "sp1",
      title: "Blinding Lights",
      artists: ["The Weeknd"],
      durationMs: 200_040,
    },
    {
      sourceId: "sp2",
      title: "Some Obscure Demo",
      artists: ["Nobody Known"],
      durationMs: 61_000,
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  mocks.parseImportSource.mockReset();
  mocks.searchRaw.mockReset();
});

describe("runClientImport", () => {
  it("auto-approves confident matches and leaves the rest out of the playlist", async () => {
    mocks.parseImportSource.mockResolvedValue(spotifyPlaylist);
    mocks.searchRaw.mockImplementation(async (query: string) =>
      query.toLowerCase().includes("blinding")
        ? [searchTrack("4NRXx6U8ABQ", "Blinding Lights", "The Weeknd", 200_000)]
        : [],
    );
    const progress: number[] = [];

    const outcome = await runClientImport(spotifyPlaylist.sourceUrl, {
      onProgress: (update) =>
        progress.push(update.result.imported + update.result.skipped),
    });

    expect(outcome.approvedTracks.map((track) => track.id)).toEqual([
      "4NRXx6U8ABQ",
    ]);
    expect(outcome.result).toEqual({ total: 2, imported: 1, skipped: 1 });
    expect(outcome.reviewItems).toEqual([]);
    expect(progress[progress.length - 1]).toBe(2);
  });

  it("names every song that failed instead of only counting it", async () => {
    mocks.parseImportSource.mockResolvedValue(spotifyPlaylist);
    mocks.searchRaw.mockImplementation(async (query: string) =>
      query.toLowerCase().includes("blinding")
        ? [searchTrack("4NRXx6U8ABQ", "Blinding Lights", "The Weeknd", 200_000)]
        : [],
    );

    const outcome = await runClientImport(spotifyPlaylist.sourceUrl);

    // The good song still imports; the failed one is named, with why.
    expect(outcome.approvedTracks).toHaveLength(1);
    expect(outcome.result).toEqual({ total: 2, imported: 1, skipped: 1 });
    expect(outcome.failedTracks).toEqual([
      {
        sourceTrack: expect.objectContaining({
          sourceId: "sp2",
          title: "Some Obscure Demo",
        }),
        reason: "no_catalog_candidates",
      },
    ]);
  });

  it("sends ambiguous matches with a candidate to review", async () => {
    mocks.parseImportSource.mockResolvedValue({
      ...spotifyPlaylist,
      tracks: [spotifyPlaylist.tracks[0]],
    });
    mocks.searchRaw.mockResolvedValue([
      searchTrack(
        "liveversion",
        "Blinding Lights (Live at SNL)",
        "The Weeknd",
        260_000,
      ),
    ]);

    const outcome = await runClientImport(spotifyPlaylist.sourceUrl);

    expect(outcome.approvedTracks).toEqual([]);
    expect(outcome.reviewItems).toHaveLength(1);
    expect(outcome.reviewItems[0]).toMatchObject({
      status: "pending",
      proposedTrack: { id: "liveversion" },
      position: 0,
    });
  });

  it("surfaces a partial canonical import: unresolved tracks are named failures and the shortfall rides the result", async () => {
    mocks.parseImportSource.mockResolvedValue({
      source: "soundcloud",
      sourceUrl: "https://soundcloud.com/listener/likes",
      title: "listener — Likes",
      canonicalTrackIds: ["sc:1", "sc:2"],
      tracks: [
        { sourceId: "1", title: "One", artists: ["u"], durationMs: 1000 },
        { sourceId: "2", title: "Two", artists: ["u"], durationMs: 1000 },
      ],
      unresolvedTracks: [
        { sourceId: "99", title: "Gone Song", artists: ["u"] },
      ],
      partial: {
        reason: "page_fetch_failed",
        missing: 601,
        expectedTotal: 603,
        resumable: true,
      },
    });

    const outcome = await runClientImport(
      "https://soundcloud.com/listener/likes",
    );

    expect(mocks.searchRaw).not.toHaveBeenCalled();
    expect(outcome.approvedTracks).toHaveLength(2);
    // total is what the source expected, not what happened to land:
    // the missing 601 stay visible in the count instead of the
    // import quietly re-basing "total" to the landed subset.
    expect(outcome.result).toEqual({ total: 603, imported: 2, skipped: 601 });
    expect(outcome.failedTracks).toEqual([
      {
        sourceTrack: expect.objectContaining({ sourceId: "99" }),
        reason: "unresolved_track",
      },
    ]);
    expect(outcome.partial).toMatchObject({
      reason: "page_fetch_failed",
      missing: 601,
      resumable: true,
    });
  });

  it("uses youtube ids directly without searching", async () => {
    mocks.parseImportSource.mockResolvedValue({
      source: "youtube",
      sourceUrl: "https://music.youtube.com/playlist?list=PL1",
      title: "Mine",
      canonicalTrackIds: ["dQw4w9WgXcQ"],
      tracks: [
        {
          sourceId: "dQw4w9WgXcQ",
          title: "Never Gonna Give You Up",
          artists: ["Rick Astley"],
          durationMs: 213_000,
        },
      ],
    });

    const outcome = await runClientImport(
      "https://music.youtube.com/playlist?list=PL1",
    );

    expect(mocks.searchRaw).not.toHaveBeenCalled();
    expect(outcome.approvedTracks[0]).toMatchObject({
      id: "dQw4w9WgXcQ",
      cover: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg" },
    });
  });
});

describe("runClientImportFromPlaylist (file imports)", () => {
  it("matches an in-hand playlist exactly like a link import", async () => {
    mocks.searchRaw.mockImplementation(async (query: string) =>
      query.toLowerCase().includes("blinding")
        ? [searchTrack("4NRXx6U8ABQ", "Blinding Lights", "The Weeknd", 200_000)]
        : [],
    );

    const outcome = await runClientImportFromPlaylist(spotifyPlaylist);

    expect(mocks.parseImportSource).not.toHaveBeenCalled();
    expect(outcome.approvedTracks).toHaveLength(1);
    expect(outcome.failedTracks).toEqual([
      {
        sourceTrack: expect.objectContaining({ sourceId: "sp2" }),
        reason: "no_catalog_candidates",
      },
    ]);
  });
});

describe("finalizeImportedPlaylist", () => {
  const track = {
    id: "dQw4w9WgXcQ",
    title: "Never Gonna Give You Up",
    artists: [{ id: "UC1", name: "Rick Astley" }],
    durationMs: 213_000,
  };
  const playlist = { id: "pl_1", title: "Mine", isPublic: false } as Awaited<
    ReturnType<typeof api.createPlaylist>
  >;

  it("saves all matched tracks in one bulk request, deduplicated", async () => {
    vi.spyOn(api, "createPlaylist").mockResolvedValue(playlist);
    const bulk = vi
      .spyOn(api, "addPlaylistTrackSnapshots")
      .mockResolvedValue({ items: [], added: 1, rejected: 0 });

    await expect(
      finalizeImportedPlaylist("Mine", undefined, [track, track]),
    ).resolves.toEqual({ playlistId: "pl_1", saved: 1, failedTracks: [] });
    expect(bulk).toHaveBeenCalledWith("pl_1", [track]);
  });

  it("falls back to per-track adds with snapshots when the bulk endpoint is missing", async () => {
    vi.spyOn(api, "createPlaylist").mockResolvedValue(playlist);
    vi.spyOn(api, "addPlaylistTrackSnapshots").mockRejectedValue(
      new ApiError(404, "Not Found"),
    );
    const single = vi
      .spyOn(api, "addPlaylistTrack")
      .mockResolvedValue(
        {} as Awaited<ReturnType<typeof api.addPlaylistTrack>>,
      );

    await expect(
      finalizeImportedPlaylist("Mine", undefined, [track]),
    ).resolves.toEqual({ playlistId: "pl_1", saved: 1, failedTracks: [] });
    expect(single).toHaveBeenCalledWith("pl_1", track.id, track);
  });

  it("survives a bulk failure and a bad song, naming what could not be saved", async () => {
    const badTrack = { ...track, id: "bad_id", title: "Unsavable" };
    vi.spyOn(api, "createPlaylist").mockResolvedValue(playlist);
    vi.spyOn(api, "addPlaylistTrackSnapshots").mockRejectedValue(
      new ApiError(500, "Server Error"),
    );
    vi.spyOn(api, "addPlaylistTrack").mockImplementation(
      async (_playlistId: string, trackId: string) => {
        if (trackId === "bad_id") throw new ApiError(422, "Unprocessable");
        return {} as Awaited<ReturnType<typeof api.addPlaylistTrack>>;
      },
    );

    await expect(
      finalizeImportedPlaylist("Mine", undefined, [track, badTrack]),
    ).resolves.toEqual({
      playlistId: "pl_1",
      saved: 1,
      failedTracks: [badTrack],
    });
  });
});
