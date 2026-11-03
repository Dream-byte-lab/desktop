// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";
import {
  useLikedTracks,
  applyOptimisticLike,
  beginOptimisticLike,
  reloadLikedTracks,
  likedTracksSnapshot,
} from "./useLikedTracks";
import { api } from "@/shared/api";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoisted = vi.hoisted(() => ({
  session: { accessToken: "test-token", user: { id: "u1" } } as any,
}));

vi.mock("@/shared/api", () => ({
  api: {
    listLikedTracks: vi.fn(),
  },
  getAuthSession: () => hoisted.session,
  toClientTrack: (track: any) => ({
    id: track.id,
    title: track.title,
    artists: track.artists || "",
    coverUrl: track.coverUrl || "",
    durationMs: track.durationMs || 0,
    playCount: track.playCount || 0,
  }),
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

const pageWith = (...ids: string[]) => ({
  items: ids.map((id) => ({
    track: { id, title: `Song ${id}`, artists: "Artist" },
    likedAt: "2026-01-01T00:00:00.000Z",
  })),
  nextCursor: null,
});

describe("useLikedTracks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    hoisted.session = { accessToken: "test-token", user: { id: "u1" } };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
  });

  it("does not flip isLoading to true when library:changed event is dispatched after initial load", async () => {
    (api.listLikedTracks as any).mockResolvedValue({
      items: [
        {
          track: { id: "track-1", title: "Song 1", artists: "Artist 1" },
        },
      ],
      nextCursor: null,
    });

    let hookResult: ReturnType<typeof useLikedTracks> | undefined;

    function TestComponent() {
      hookResult = useLikedTracks();
      return <div>loaded: {(!hookResult.isLoading).toString()}</div>;
    }

    await act(async () => {
      root.render(<TestComponent />);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(hookResult?.isLoading).toBe(false);
    expect(hookResult?.data.tracks).toHaveLength(1);

    // Apply optimistic like
    act(() => {
      applyOptimisticLike("track-2");
    });
    expect(hookResult?.data.tracks).toHaveLength(2);
    expect(hookResult?.isLoading).toBe(false);

    // Dispatch library:changed event to simulate background update after liking
    let backgroundPromiseResolve: (value: any) => void;
    const backgroundPromise = new Promise((resolve) => {
      backgroundPromiseResolve = resolve;
    });

    (api.listLikedTracks as any).mockImplementation(() => backgroundPromise);

    await act(async () => {
      window.dispatchEvent(new Event("library:changed"));
    });

    // isLoading MUST REMAIN FALSE during background refetch
    expect(hookResult?.isLoading).toBe(false);

    // Resolve background refetch
    await act(async () => {
      backgroundPromiseResolve!({
        items: [
          { track: { id: "track-1", title: "Song 1", artists: "Artist 1" } },
          { track: { id: "track-2", title: "Song 2", artists: "Artist 2" } },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
    });

    expect(hookResult?.isLoading).toBe(false);
    expect(hookResult?.data.tracks).toHaveLength(2);
  });

  it("keeps a settled override created after a load started when that load completes", async () => {
    const first = deferred<any>();
    (api.listLikedTracks as any).mockImplementation(() => first.promise);

    let pending!: Promise<void>;
    await act(async () => {
      pending = reloadLikedTracks();
    });
    expect(api.listLikedTracks).toHaveBeenCalledTimes(1);

    // Intent lands (and its mutation settles) while the fetch is out:
    // the fetched page cannot speak for it, so it must survive.
    act(() => {
      const handle = beginOptimisticLike("track-new");
      handle.settleSucceeded();
    });

    await act(async () => {
      first.resolve(pageWith("track-1"));
      await pending;
    });

    const ids = likedTracksSnapshot().tracks.map((t) => t.id);
    expect(ids).toContain("track-new");
    expect(ids).toContain("track-1");

    // Cleanup: a load that starts after the override settled may drop it.
    (api.listLikedTracks as any).mockResolvedValue(pageWith("track-1"));
    await act(async () => {
      await reloadLikedTracks();
    });
    expect(likedTracksSnapshot().tracks.map((t) => t.id)).not.toContain(
      "track-new",
    );
  });

  it("queues exactly one follow-up when a forced reload lands during a fetch", async () => {
    const pages: ReturnType<typeof deferred<any>>[] = [];
    (api.listLikedTracks as any).mockImplementation(() => {
      const d = deferred<any>();
      pages.push(d);
      return d.promise;
    });

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = reloadLikedTracks();
    });
    expect(api.listLikedTracks).toHaveBeenCalledTimes(1);

    await act(async () => {
      second = reloadLikedTracks();
      void reloadLikedTracks();
    });
    // Still only the in-flight fetch: the forced reloads coalesce.
    expect(api.listLikedTracks).toHaveBeenCalledTimes(1);

    await act(async () => {
      pages[0].resolve(pageWith("track-1"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(api.listLikedTracks).toHaveBeenCalledTimes(2);

    await act(async () => {
      pages[1].resolve(pageWith("track-1", "track-3"));
      await second;
      await first;
    });
    expect(api.listLikedTracks).toHaveBeenCalledTimes(2);
    expect(likedTracksSnapshot().tracks.map((t) => t.id)).toContain("track-3");
  });

  it("discards an in-flight load and clears overrides when the account switches", async () => {
    const pages: ReturnType<typeof deferred<any>>[] = [];
    (api.listLikedTracks as any).mockImplementation(() => {
      const d = deferred<any>();
      pages.push(d);
      return d.promise;
    });

    await act(async () => {
      void reloadLikedTracks();
    });
    expect(api.listLikedTracks).toHaveBeenCalledTimes(1);

    act(() => {
      applyOptimisticLike("u1-only-track");
    });
    expect(likedTracksSnapshot().tracks.map((t) => t.id)).toContain(
      "u1-only-track",
    );

    // Direct A -> B switch while A's fetch is still out.
    hoisted.session = { accessToken: "token-b", user: { id: "u2" } };
    await act(async () => {
      window.dispatchEvent(new Event("auth:changed"));
    });
    // A's optimistic intent is gone with A's session.
    expect(likedTracksSnapshot().tracks.map((t) => t.id)).not.toContain(
      "u1-only-track",
    );

    await act(async () => {
      pages[0].resolve(pageWith("track-from-a"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    // A's page was discarded; a fresh fetch for B was queued instead.
    expect(likedTracksSnapshot().tracks.map((t) => t.id)).not.toContain(
      "track-from-a",
    );
    expect(api.listLikedTracks).toHaveBeenCalledTimes(2);

    await act(async () => {
      pages[1].resolve(pageWith("track-from-b"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(likedTracksSnapshot().tracks.map((t) => t.id)).toEqual([
      "track-from-b",
    ]);
  });
});
