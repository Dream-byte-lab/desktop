import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  rememberSoundCloudClientId,
  resetSoundCloudClientIdCache,
} from "@/shared/media/soundcloud";
import { importSoundCloud } from "./soundcloudSource";

const STALE_ID = "stale000000000000000000000000000";
const FRESH_ID = "fresh000000000000000000000000000";
const HOME_HTML =
  '<script src="https://a-v2.sndcdn.com/assets/app.js"></script>';

function likesPage(trackId: number, nextHref?: string) {
  const track = {
    id: trackId,
    title: `Song ${trackId}`,
    user: { username: "u" },
  };
  return { collection: [{ track }], next_href: nextHref };
}

function respond(url: URL): unknown {
  const clientId = url.searchParams.get("client_id");
  if (url.origin === "https://soundcloud.com") return HOME_HTML;
  if (url.hostname === "a-v2.sndcdn.com") return `client_id:"${FRESH_ID}"`;
  if (clientId !== FRESH_ID) return 401;
  if (url.pathname === "/resolve")
    return { kind: "user", id: 7, username: "listener" };
  if (url.pathname === "/users/7/likes" && !url.searchParams.has("offset")) {
    return likesPage(
      1,
      "https://api-v2.soundcloud.com/users/7/likes?offset=abc&limit=50",
    );
  }
  if (url.pathname === "/users/7/likes") return likesPage(2);
  return 404;
}

beforeEach(() => {
  resetSoundCloudClientIdCache();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const body = respond(new URL(input.toString()));
      if (typeof body === "number") return new Response("", { status: body });
      return new Response(
        typeof body === "string" ? body : JSON.stringify(body),
        { status: 200 },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("importSoundCloud", () => {
  it("stops if the API sends an already visited likes page", async () => {
    rememberSoundCloudClientId(FRESH_ID);
    const fetchMock = vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(input.toString());
      const body =
        url.pathname === "/users/7/likes"
          ? likesPage(1, "https://api-v2.soundcloud.com/users/7/likes?limit=50")
          : respond(url);
      return new Response(JSON.stringify(body));
    });

    const playlist = await importSoundCloud(
      "https://soundcloud.com/listener/likes",
    );

    expect(playlist.tracks.map((track) => track.title)).toEqual(["Song 1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("imports likes beyond twenty pages until there is no next page", async () => {
    rememberSoundCloudClientId(FRESH_ID);
    const fetchMock = vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname !== "/users/7/likes") {
        return new Response(JSON.stringify(respond(url)));
      }
      const page = Number(url.searchParams.get("offset") ?? 0);
      const collection = Array.from(
        { length: page === 32 ? 5 : 50 },
        (_, i) => ({
          track: {
            id: page * 50 + i + 1,
            title: `Song ${page * 50 + i + 1}`,
            user: { username: "u" },
          },
        }),
      );
      return new Response(
        JSON.stringify({
          collection,
          next_href:
            page < 32
              ? `https://api-v2.soundcloud.com/users/7/likes?offset=${page + 1}&limit=50`
              : null,
        }),
      );
    });

    const playlist = await importSoundCloud(
      "https://soundcloud.com/listener/likes",
    );

    expect(playlist.tracks).toHaveLength(1605);
    expect(playlist.tracks[0].title).toBe("Song 1");
    expect(playlist.tracks[1604].title).toBe("Song 1605");
    expect(fetchMock).toHaveBeenCalledTimes(34);
  });

  it("reports a partial likes import when a late page fails, and a retry resumes it (upstream #288 shape)", async () => {
    rememberSoundCloudClientId(FRESH_ID);
    let failLatePage = true;
    const likesCalls: number[] = [];
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(input.toString());
      if (url.pathname !== "/users/7/likes") {
        return new Response(JSON.stringify(respond(url)));
      }
      const pageNo = Number(url.searchParams.get("offset") ?? 0);
      likesCalls.push(pageNo);
      if (failLatePage && pageNo === 19)
        return new Response("", { status: 500 });
      const collection = Array.from({ length: 50 }, (_, i) => ({
        track: {
          id: pageNo * 50 + i + 1,
          title: `Song ${pageNo * 50 + i + 1}`,
          user: { username: "u" },
        },
      }));
      return new Response(
        JSON.stringify({
          collection,
          next_href:
            pageNo < 32
              ? `https://api-v2.soundcloud.com/users/7/likes?offset=${pageNo + 1}&limit=50`
              : null,
        }),
      );
    });

    // 1,650 likes; the page carrying tracks 951–1000 fails. Before
    // this fix the import landed 950 tracks and reported a clean
    // success — the shortfall existed only in a log line.
    const first = await importSoundCloud(
      "https://soundcloud.com/listener/likes",
    );
    expect(first.tracks).toHaveLength(950);
    expect(first.partial).toMatchObject({
      reason: "page_fetch_failed",
      resumable: true,
    });

    failLatePage = false;
    likesCalls.length = 0;
    const second = await importSoundCloud(
      "https://soundcloud.com/listener/likes",
    );
    expect(second.tracks).toHaveLength(1650);
    expect(second.partial).toBeUndefined();
    // Resumed at the failed page, not restarted from the first one.
    expect(likesCalls[0]).toBe(19);
    expect(likesCalls).not.toContain(0);
  });

  it("keeps unresolved tracks visible instead of dropping them silently", async () => {
    rememberSoundCloudClientId(FRESH_ID);
    const hydration = [
      {
        hydratable: "playlist",
        data: {
          title: "SC PL",
          tracks: [
            {
              id: 11,
              title: "Song",
              duration: 5000,
              user: { id: 3, username: "uploader" },
            },
            { id: 12 },
          ],
        },
      },
    ];
    vi.mocked(fetch).mockImplementation(async (input) => {
      const url = new URL(input.toString());
      if (url.origin === "https://soundcloud.com") {
        return new Response(
          `<script>window.__sc_hydration = ${JSON.stringify(hydration)};</script>`,
        );
      }
      if (url.pathname === "/tracks") return new Response(JSON.stringify([]));
      return new Response("", { status: 404 });
    });

    const playlist = await importSoundCloud(
      "https://soundcloud.com/user/sets/pl",
    );

    expect(playlist.tracks.map((track) => track.title)).toEqual(["Song"]);
    expect(playlist.unresolvedTracks).toHaveLength(1);
    expect(playlist.unresolvedTracks?.[0]).toMatchObject({ sourceId: "12" });
    expect(playlist.partial).toMatchObject({
      reason: "unresolved_tracks",
      missing: 1,
    });
  });

  it("resolves likes through the shared api client and refreshes a rejected client id", async () => {
    rememberSoundCloudClientId(STALE_ID);
    const playlist = await importSoundCloud(
      "https://soundcloud.com/listener/likes",
    );
    expect(playlist.title).toBe("listener — Likes");
    expect(playlist.tracks.map((track) => track.title)).toEqual([
      "Song 1",
      "Song 2",
    ]);
  });
});
