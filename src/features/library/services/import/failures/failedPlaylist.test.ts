import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/shared/api";
import type { ImportJob, ImportReview, Track } from "@/shared/contracts";
import {
  FailedImportsStore,
  failedImports,
  type FailedImportEntry,
  type FailedImportStorage,
} from "./failedImportsStore";
import {
  FailedPlaylist,
  FAILED_PLAYLIST_TITLE,
  failedPlaylist,
} from "./failedPlaylist";
import { recoverFailedImports } from "./recoverFailedImports";
import {
  createLocalImportJob,
  finalizeLocalImport,
  onLocalImportJobChange,
  updateLocalImportJob,
} from "../manager/localImportJobs";

function memoryStorage(): FailedImportStorage & {
  value: string | null;
  writes: number;
} {
  return {
    value: null,
    writes: 0,
    read() {
      return this.value;
    },
    write(value: string) {
      this.writes += 1;
      this.value = value;
    },
  };
}

const track = (id: string, title: string): Track =>
  ({
    id,
    title,
    artists: [{ id: `a-${id}`, name: "Artist" }],
    durationMs: 1000,
  }) as Track;

const matchingFailure = (sourceId: string, title: string) => ({
  sourceTrack: {
    sourceId,
    title,
    artists: ["Artist"],
    durationMs: 1000,
  },
  reason: "no_catalog_candidates",
});

let playlistSeq = 0;

function mockPlaylistApi() {
  playlistSeq = 0;
  vi.spyOn(api, "createPlaylist").mockImplementation(async () => {
    playlistSeq += 1;
    return {
      id: `pl_${playlistSeq}`,
      title: "Imported",
      isPublic: false,
    } as Awaited<ReturnType<typeof api.createPlaylist>>;
  });
  vi.spyOn(api, "addPlaylistTrackSnapshots").mockImplementation(
    async (_id: string, tracks: unknown[]) => ({
      items: [],
      added: tracks.length,
      rejected: 0,
    }),
  );
}

beforeEach(() => {
  failedImports.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FailedPlaylist identity", () => {
  it("is found-or-created exactly once and reused forever", () => {
    const storage = memoryStorage();
    const store = new FailedImportsStore(memoryStorage());
    const first = new FailedPlaylist({ storage, store });
    expect(first.identity()).toBeNull();

    const created = first.ensure();
    expect(created.title).toBe(FAILED_PLAYLIST_TITLE);
    expect(FAILED_PLAYLIST_TITLE).toBe("Could not import");
    expect(storage.writes).toBe(1);

    // A second instance (a later launch) finds the same playlist
    // and never creates another.
    const second = new FailedPlaylist({ storage, store });
    expect(second.ensure()).toEqual(created);
    expect(first.ensure()).toEqual(created);
    expect(storage.writes).toBe(1);
  });

  it("creates nothing for a save with no failures", () => {
    const storage = memoryStorage();
    const playlist = new FailedPlaylist({
      storage,
      store: new FailedImportsStore(memoryStorage()),
    });
    expect(playlist.save([])).toEqual([]);
    expect(playlist.identity()).toBeNull();
    expect(storage.writes).toBe(0);
  });
});

describe("imports saving into the one playlist", () => {
  it("collects the failures of two different imports into the same single playlist", async () => {
    mockPlaylistApi();
    // Import B has one song the library refuses to save at all.
    vi.spyOn(api, "addPlaylistTrackSnapshots").mockRejectedValue(
      new ApiError(500, "Server Error"),
    );
    vi.spyOn(api, "addPlaylistTrack").mockImplementation(
      async (_playlistId: string, trackId: string) => {
        if (trackId === "unsavable") throw new ApiError(422, "Unprocessable");
        return {} as Awaited<ReturnType<typeof api.addPlaylistTrack>>;
      },
    );

    const jobA = createLocalImportJob("spotify", "https://example.com/a");
    await finalizeLocalImport(
      jobA.id,
      [track("good-a", "Good A")],
      "Road trip",
      undefined,
      [matchingFailure("lost-a", "Lost A")],
    );
    const identityAfterA = failedPlaylist.identity();
    expect(identityAfterA).not.toBeNull();

    const jobB = createLocalImportJob("deezer", "https://example.com/b");
    await finalizeLocalImport(
      jobB.id,
      [track("good-b", "Good B"), track("unsavable", "Unsavable B")],
      "Chill",
      undefined,
      [matchingFailure("lost-b", "Lost B")],
    );

    // Still the same one playlist — never a second one.
    expect(failedPlaylist.identity()?.id).toBe(identityAfterA?.id);

    const entries = failedImports.list();
    const byKey = new Map(entries.map((entry) => [entry.key, entry]));
    expect(byKey.get("spotify:lost-a")).toMatchObject({
      stage: "matching",
      importTitle: "Road trip",
    });
    expect(byKey.get("deezer:lost-b")).toMatchObject({
      stage: "matching",
      importTitle: "Chill",
    });
    // The unsavable song failed at the saving stage, under its
    // catalogue id, and is kept too.
    expect(byKey.get("deezer:unsavable")).toMatchObject({
      stage: "saving",
      reason: "save_failed",
      sourceTrack: { title: "Unsavable B" },
    });
    expect(entries).toHaveLength(3);
  });

  it("has the playlist populated at the moment the import reports itself finished", async () => {
    mockPlaylistApi();
    const job = createLocalImportJob("spotify", "https://example.com/a");
    let countWhenCompleted = -1;
    const unsubscribe = onLocalImportJobChange((updated) => {
      if (updated.id === job.id && updated.status === "completed") {
        countWhenCompleted = failedImports.list().length;
      }
    });
    try {
      await finalizeLocalImport(
        job.id,
        [track("good", "Good")],
        "Road trip",
        undefined,
        [matchingFailure("lost", "Lost")],
      );
    } finally {
      unsubscribe();
    }
    // No user action happened between finalize resolving and the
    // job completing — the songs were already in the playlist.
    expect(countWhenCompleted).toBe(1);
    expect(failedImports.list()).toHaveLength(1);
  });

  it("marks a partial import completed-with-partial, never a clean complete", async () => {
    mockPlaylistApi();
    const job = createLocalImportJob(
      "soundcloud",
      "https://soundcloud.com/listener/likes",
    );
    updateLocalImportJob(job.id, {
      result: { total: 603, imported: 0, skipped: 0 },
    });
    let completed: ImportJob | undefined;
    const unsubscribe = onLocalImportJobChange((updated) => {
      if (updated.id === job.id && updated.status === "completed") {
        completed = updated;
      }
    });
    try {
      await finalizeLocalImport(
        job.id,
        [track("sc:1", "One")],
        "listener — Likes",
        undefined,
        [],
        {
          reason: "page_fetch_failed",
          missing: 601,
          expectedTotal: 603,
          resumable: true,
        },
      );
    } finally {
      unsubscribe();
    }
    expect(completed?.status).toBe("completed");
    expect(completed?.partial).toMatchObject({
      reason: "page_fetch_failed",
      missing: 601,
      expectedTotal: 603,
      resumable: true,
    });
    // The shortfall rides the result counts too: 603 expected,
    // 1 saved, the rest visibly unaccounted-for — not re-based.
    expect(completed?.result).toEqual({
      total: 603,
      imported: 1,
      skipped: 602,
    });
  });

  it("keeps a single entry when the same song fails in two imports", async () => {
    mockPlaylistApi();
    const jobA = createLocalImportJob("spotify", "https://example.com/a");
    await finalizeLocalImport(jobA.id, [], "Road trip", undefined, [
      matchingFailure("dup", "Same Song"),
    ]);
    const jobB = createLocalImportJob("spotify", "https://example.com/b");
    await finalizeLocalImport(jobB.id, [], "Chill", undefined, [
      matchingFailure("dup", "Same Song"),
    ]);

    const entries = failedImports.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: "spotify:dup",
      attempts: 2,
      importTitle: "Chill",
    });
  });
});

describe("review-stage leftovers", () => {
  const reviewItem = (
    id: string,
    sourceId: string,
    title: string,
    proposedId: string,
  ): ImportReview => ({
    id,
    sourceTrack: {
      sourceId,
      title,
      artists: ["Artist"],
      durationMs: 1000,
    },
    proposedTrack: track(proposedId, title),
    reason: "low_confidence_match",
    status: "pending",
    position: 0,
    createdAt: "2026-11-02T00:00:00.000Z",
  });

  it("records the songs turned down at review, which used to vanish", async () => {
    mockPlaylistApi();
    const job = createLocalImportJob("spotify", "https://example.com/a");
    updateLocalImportJob(
      job.id,
      {
        status: "awaiting_decision",
        requiresDecision: true,
        title: "Road trip",
        result: { total: 2, imported: 0, skipped: 2 },
      },
      [
        reviewItem("r1", "keep-me", "Kept Song", "yt-keep"),
        reviewItem("r2", "deny-me", "Denied Song", "yt-deny"),
      ],
    );

    // The modal's decide flow finalizes with the approved tracks
    // only; the denied one must land in the failed playlist.
    await finalizeLocalImport(job.id, [track("yt-keep", "Kept Song")]);

    const entries = failedImports.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: "spotify:deny-me",
      reason: "review_denied",
      stage: "review",
      importTitle: "Road trip",
      sourceTrack: { title: "Denied Song" },
    });
  });

  it("records every review song when the review is skipped wholesale", async () => {
    mockPlaylistApi();
    const job = createLocalImportJob("spotify", "https://example.com/a");
    updateLocalImportJob(
      job.id,
      {
        status: "awaiting_decision",
        requiresDecision: true,
        title: "Road trip",
        result: { total: 2, imported: 0, skipped: 2 },
      },
      [
        reviewItem("r1", "one", "One", "yt-one"),
        reviewItem("r2", "two", "Two", "yt-two"),
      ],
    );

    // Skip-all finalizes with no review tracks at all.
    await finalizeLocalImport(job.id, []);

    const keys = failedImports.list().map((entry) => entry.key);
    expect(keys.sort()).toEqual(["spotify:one", "spotify:two"]);
    expect(
      failedImports.list().every((entry) => entry.reason === "review_denied"),
    ).toBe(true);
  });
});

describe("recoverFailedImports", () => {
  const entry = (sourceId: string, title: string): FailedImportEntry => ({
    key: `spotify:${sourceId}`,
    source: "spotify",
    sourceTrack: { sourceId, title, artists: ["Artist"], durationMs: 1000 },
    reason: "no_catalog_candidates",
    stage: "matching",
    importTitle: "Road trip",
    failedAt: "2026-11-02T00:00:00.000Z",
    attempts: 1,
  });

  it("removes a recovered song from the failed playlist and keeps the rest", async () => {
    const store = new FailedImportsStore(memoryStorage());
    const found = entry("found-now", "Found");
    const missing = entry("still-missing", "Missing");
    store.record([
      {
        source: found.source,
        sourceTrack: found.sourceTrack,
        reason: found.reason,
        stage: found.stage,
        importTitle: found.importTitle,
        failedAt: found.failedAt,
      },
      {
        source: missing.source,
        sourceTrack: missing.sourceTrack,
        reason: missing.reason,
        stage: missing.stage,
        importTitle: missing.importTitle,
        failedAt: missing.failedAt,
      },
    ]);

    const savedTo: string[] = [];
    const outcome = await recoverFailedImports(store.list(), {
      store,
      match: (async (source: { sourceId: string }) =>
        source.sourceId === "found-now"
          ? {
              status: "approved" as const,
              track: track("yt-1", "Found"),
              score: 99,
            }
          : {
              status: "pending" as const,
              reason: "no_catalog_candidates" as const,
            }) as never,
      save: async (title: string) => {
        savedTo.push(title);
        return { failedTracks: [] };
      },
    });

    expect(outcome.recoveredCount).toBe(1);
    expect(outcome.stillFailingCount).toBe(1);
    expect(savedTo).toEqual(["Road trip — recovered"]);
    const remaining = store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].key).toBe("spotify:still-missing");
  });

  it("keeps a song that matched but could not be saved, as a saving failure", async () => {
    const store = new FailedImportsStore(memoryStorage());
    const held = entry("unsavable", "Unsavable");
    store.record([
      {
        source: held.source,
        sourceTrack: held.sourceTrack,
        reason: held.reason,
        stage: held.stage,
        importTitle: held.importTitle,
        failedAt: held.failedAt,
      },
    ]);

    const outcome = await recoverFailedImports(store.list(), {
      store,
      match: (async () => ({
        status: "approved" as const,
        track: track("yt-9", "Unsavable"),
        score: 99,
      })) as never,
      save: async () => ({ failedTracks: [track("yt-9", "Unsavable")] }),
    });

    expect(outcome.recoveredCount).toBe(0);
    const remaining = store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      key: "spotify:unsavable",
      reason: "save_failed",
      stage: "saving",
    });
  });
});
