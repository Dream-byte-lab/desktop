// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoisted = vi.hoisted(() => ({
  session: { accessToken: "token-a", user: { id: "u1" } } as any,
}));

vi.mock("@/shared/api", () => ({
  api: {
    likeTrack: vi.fn(),
    unlikeTrack: vi.fn(),
    listLikedTracks: vi.fn(),
  },
  getAuthSession: () => hoisted.session,
  toClientTrack: (track: any) => ({
    id: track.id,
    title: track.title || "",
    artists: track.artists || "",
    coverUrl: track.coverUrl || "",
    durationMs: track.durationMs || 0,
    playCount: track.playCount || 0,
  }),
}));

vi.mock("./usePlaylists", () => ({
  notifyLibraryChanged: () =>
    window.dispatchEvent(new Event("library:changed")),
  evictPlaylistFromCache: () => {},
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup() {
  vi.resetModules();
  vi.clearAllMocks();
  const liked = await import("./useLikedTracks");
  const muts = await import("./useLibraryMutations");
  const { api } = await import("@/shared/api");

  // A tiny fake server: like/unlike mutate it, the liked list reads it.
  const serverLiked = new Set<string>();
  (api.likeTrack as any).mockImplementation(async (id: string) => {
    serverLiked.add(id);
  });
  (api.unlikeTrack as any).mockImplementation(async (id: string) => {
    serverLiked.delete(id);
  });
  (api.listLikedTracks as any).mockImplementation(async () => ({
    items: [...serverLiked].map((id) => ({
      track: { id, title: `Song ${id}` },
      likedAt: "2026-01-01T00:00:00.000Z",
    })),
    nextCursor: null,
  }));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  let hooks: {
    like: ReturnType<typeof muts.useLikeTrack>;
    unlike: ReturnType<typeof muts.useUnlikeTrack>;
  } | null = null;
  function Probe() {
    const like = muts.useLikeTrack();
    const unlike = muts.useUnlikeTrack();
    hooks = { like, unlike };
    return null;
  }
  await act(async () => {
    root.render(<Probe />);
  });
  return {
    liked,
    muts,
    api,
    serverLiked,
    root,
    container,
    hooks: () => hooks!,
  };
}

describe("useLikeTrack / useUnlikeTrack race-proofing", () => {
  let current: Setup;

  beforeEach(() => {
    hoisted.session = { accessToken: "token-a", user: { id: "u1" } };
  });

  afterEach(async () => {
    if (current) {
      // Drain any trailing debounced notification from this test's
      // mutations so it cannot land inside the next test's counters.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      act(() => {
        current.root.unmount();
      });
      document.body.removeChild(current.container);
    }
  });

  it("sends rapid like -> unlike -> like for one track to the api in intent order", async () => {
    current = await setup();
    const { api, hooks, liked, serverLiked } = current;

    const calls: string[] = [];
    const gates: ReturnType<typeof deferred<void>>[] = [];
    let likeCount = 0;
    (api.likeTrack as any).mockImplementation((id: string) => {
      likeCount += 1;
      calls.push(`like#${likeCount}`);
      const gate = deferred<void>();
      gates.push(gate);
      return gate.promise.then(() => {
        serverLiked.add(id);
      });
    });
    (api.unlikeTrack as any).mockImplementation((id: string) => {
      calls.push("unlike#1");
      const gate = deferred<void>();
      gates.push(gate);
      return gate.promise.then(() => {
        serverLiked.delete(id);
      });
    });

    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    let p3!: Promise<unknown>;
    await act(async () => {
      p1 = hooks().like.mutateAsync("t1");
      p2 = hooks().unlike.mutateAsync("t1");
      p3 = hooks().like.mutateAsync("t1");
    });
    await flush();
    // Only the first intent has reached the api; the rest are queued.
    expect(calls).toEqual(["like#1"]);

    await act(async () => {
      gates[0].resolve();
    });
    await flush();
    expect(calls).toEqual(["like#1", "unlike#1"]);

    await act(async () => {
      gates[1].resolve();
    });
    await flush();
    expect(calls).toEqual(["like#1", "unlike#1", "like#2"]);

    await act(async () => {
      gates[2].resolve();
      await Promise.all([p1, p2, p3]);
    });
    expect(serverLiked.has("t1")).toBe(true);
    expect(liked.likedTracksSnapshot().tracks.map((t) => t.id)).toContain("t1");
  });

  it("does not resurrect a stale state when like and unlike both fail", async () => {
    current = await setup();
    const { api, hooks, liked } = current;

    const gates: ReturnType<typeof deferred<void>>[] = [];
    (api.likeTrack as any).mockImplementation(() => {
      const gate = deferred<void>();
      gates.push(gate);
      return gate.promise;
    });
    (api.unlikeTrack as any).mockImplementation(() => {
      const gate = deferred<void>();
      gates.push(gate);
      return gate.promise;
    });

    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    await act(async () => {
      p1 = hooks().like.mutateAsync("t1");
      p1.catch(() => {});
      p2 = hooks().unlike.mutateAsync("t1");
      p2.catch(() => {});
    });
    await flush();
    expect(api.likeTrack).toHaveBeenCalledTimes(1);
    expect(api.unlikeTrack).not.toHaveBeenCalled();

    await act(async () => {
      gates[0].reject(new Error("like failed"));
    });
    await flush();
    expect(api.unlikeTrack).toHaveBeenCalledTimes(1);

    await act(async () => {
      gates[1].reject(new Error("unlike failed"));
      await Promise.allSettled([p1, p2]);
    });
    // Both failed: the UI falls back to the server state (not liked).
    // The old rollback would have restored the unlike's captured
    // prev=true and left the track wrongly shown as liked.
    expect(liked.likedTracksSnapshot().tracks.map((t) => t.id)).not.toContain(
      "t1",
    );
  });

  it("turns a burst of three toggles into one debounced library:changed", async () => {
    current = await setup();
    const { hooks } = current;

    let notifications = 0;
    const count = () => {
      notifications += 1;
    };
    window.addEventListener("library:changed", count);
    try {
      await act(async () => {
        await Promise.all([
          hooks().like.mutateAsync("t-a"),
          hooks().like.mutateAsync("t-b"),
          hooks().unlike.mutateAsync("t-c"),
        ]);
      });
      expect(notifications).toBe(0);

      await act(async () => {
        await new Promise((r) => setTimeout(r, 400));
      });
      expect(notifications).toBe(1);
    } finally {
      window.removeEventListener("library:changed", count);
    }
  });

  it("drops a queued operation whose account changed before it was sent", async () => {
    current = await setup();
    const { api, hooks } = current;

    const gate = deferred<void>();
    (api.likeTrack as any).mockImplementation(() => gate.promise);

    let p1!: Promise<unknown>;
    let p2!: Promise<unknown>;
    await act(async () => {
      p1 = hooks().like.mutateAsync("t1");
      p2 = hooks().unlike.mutateAsync("t1");
      p2.catch(() => {});
    });
    await flush();
    expect(api.likeTrack).toHaveBeenCalledTimes(1);

    // Account switches while the unlike is still queued behind the like.
    hoisted.session = { accessToken: "token-b", user: { id: "u2" } };

    await act(async () => {
      gate.resolve();
      await Promise.allSettled([p1, p2]);
    });
    await expect(p2).rejects.toThrow(/account changed/i);
    expect(api.unlikeTrack).not.toHaveBeenCalled();
  });
});
