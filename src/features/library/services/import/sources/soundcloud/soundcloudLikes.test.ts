import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSoundCloudApi } from "@/shared/media/soundcloud";
import { log } from "@/shared/utils/logger";
import { createSoundCloudCollection } from "./soundcloudCollection";
import { collectSoundCloudLikes, MAX_LIKES_PAGES } from "./soundcloudLikes";

vi.mock("@/shared/media/soundcloud", () => ({
  SOUNDCLOUD_API: "https://api-v2.soundcloud.com",
  fetchSoundCloudApi: vi.fn(),
}));

vi.mock("@/shared/utils/logger", () => ({ log: vi.fn() }));

const fetchMock = vi.mocked(fetchSoundCloudApi);
const logMock = vi.mocked(log);

function page(offset: number, next: boolean): Response {
  return new Response(
    JSON.stringify({
      collection: [{ track: { id: offset, title: `Song ${offset}` } }],
      next_href: next
        ? `https://api-v2.soundcloud.com/users/7/likes?offset=${offset + 1}&limit=50`
        : null,
    }),
  );
}

function offsetOf(pathOrUrl: string): number {
  return Number(
    new URL(pathOrUrl, "https://api-v2.soundcloud.com").searchParams.get(
      "offset",
    ) ?? 0,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  logMock.mockReset();
});

describe("collectSoundCloudLikes", () => {
  it("stops at the page limit when the API keeps sending new pages", async () => {
    fetchMock.mockImplementation(async (pathOrUrl) =>
      page(offsetOf(pathOrUrl), true),
    );
    const collection = createSoundCloudCollection();

    await collectSoundCloudLikes({ id: 7 }, "listener", collection);

    expect(fetchMock).toHaveBeenCalledTimes(MAX_LIKES_PAGES);
    expect(collection.rawTracks).toHaveLength(MAX_LIKES_PAGES);
    expect(logMock).toHaveBeenCalledWith(
      "yellow",
      "import",
      expect.stringContaining(`stopped at ${MAX_LIKES_PAGES} pages`),
    );
  });

  it("keeps fetched tracks and logs when a later page fails", async () => {
    fetchMock.mockImplementation(async (pathOrUrl) => {
      const offset = offsetOf(pathOrUrl);
      return offset === 2
        ? new Response("", { status: 500 })
        : page(offset, true);
    });
    const collection = createSoundCloudCollection();

    await collectSoundCloudLikes({ id: 7 }, "listener", collection);

    expect(collection.rawTracks).toHaveLength(2);
    expect(logMock).toHaveBeenCalledWith(
      "yellow",
      "import",
      "soundcloud likes import is partial: page 3 failed with 500, kept 2 tracks",
    );
  });

  it("does not log when every page loads", async () => {
    fetchMock.mockImplementation(async (pathOrUrl) => {
      const offset = offsetOf(pathOrUrl);
      return page(offset, offset < 3);
    });
    const collection = createSoundCloudCollection();

    await collectSoundCloudLikes({ id: 7 }, "listener", collection);

    expect(collection.rawTracks).toHaveLength(4);
    expect(logMock).not.toHaveBeenCalled();
  });
});

describe("collectSoundCloudLikes partial state and resume", () => {
  it("marks the collection partial when a page fails and resumes from that page on retry", async () => {
    let failPage = true;
    fetchMock.mockImplementation(async (pathOrUrl) => {
      const offset = offsetOf(pathOrUrl);
      if (failPage && offset === 2) return new Response("", { status: 500 });
      return page(offset, offset < 3);
    });

    const first = createSoundCloudCollection();
    await collectSoundCloudLikes({ id: 42 }, "listener", first);

    // The shortfall is on the collection, not only in a log line.
    expect(first.rawTracks).toHaveLength(2);
    expect(first.partial).toMatchObject({
      reason: "page_fetch_failed",
      resumable: true,
    });

    failPage = false;
    fetchMock.mockClear();
    const second = createSoundCloudCollection();
    await collectSoundCloudLikes({ id: 42 }, "listener", second);

    // The retry resumed at the failed page instead of restarting
    // from page one: it fetched only offsets 2 and 3, seeded the
    // two already-fetched tracks, and finished complete.
    const offsets = fetchMock.mock.calls.map((call) => offsetOf(call[0]));
    expect(offsets).toEqual([2, 3]);
    expect(second.rawTracks).toHaveLength(4);
    expect(second.partial).toBeUndefined();
  });

  it("counts the shortfall against likes_count when the source reports it", async () => {
    fetchMock.mockImplementation(async (pathOrUrl) => {
      const offset = offsetOf(pathOrUrl);
      return offset === 2
        ? new Response("", { status: 500 })
        : page(offset, true);
    });
    const collection = createSoundCloudCollection();

    await collectSoundCloudLikes(
      { id: 43, likes_count: 5 },
      "listener",
      collection,
    );

    expect(collection.rawTracks).toHaveLength(2);
    expect(collection.partial).toMatchObject({
      reason: "page_fetch_failed",
      expectedTotal: 5,
      missing: 3,
      resumable: true,
    });
  });

  it("flags a shortfall when the API ends before likes_count is reached", async () => {
    fetchMock.mockImplementation(async (pathOrUrl) =>
      page(offsetOf(pathOrUrl), offsetOf(pathOrUrl) < 1),
    );
    const collection = createSoundCloudCollection();

    await collectSoundCloudLikes(
      { id: 45, likes_count: 10 },
      "listener",
      collection,
    );

    expect(collection.rawTracks).toHaveLength(2);
    expect(collection.partial).toMatchObject({
      reason: "count_shortfall",
      expectedTotal: 10,
      missing: 8,
      resumable: false,
    });
  });

  it("marks the collection partial at the page cap, which is the 25,000-track ceiling", async () => {
    fetchMock.mockImplementation(async (pathOrUrl) =>
      page(offsetOf(pathOrUrl), true),
    );
    const collection = createSoundCloudCollection();

    await collectSoundCloudLikes({ id: 44 }, "listener", collection);

    expect(collection.rawTracks).toHaveLength(MAX_LIKES_PAGES);
    expect(collection.partial).toMatchObject({
      reason: "page_cap_reached",
      resumable: true,
    });
    // The ceiling the user is told about at import time: pages × page size.
    expect(MAX_LIKES_PAGES * 50).toBe(25_000);
  });
});
