// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

// S0 companion: the Library page's playlists Retry
// (retryPlaylistsLoad) must actually re-run the list load —
// clearing the error and landing the playlists on success, and
// keeping the error (honestly) when the load fails again. The
// list store is a module singleton, so each case imports a fresh
// module instance.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/shared/api", () => ({
  api: {
    readUserPlaylist: vi.fn(),
    listPlaylists: vi.fn(),
    getUserPlaylist: vi.fn(),
  },
  getAuthSession: () => ({ accessToken: "test-token", user: { id: "u1" } }),
  mediaUrl: (url: string) => url,
  toClientTrack: (track: any) => ({
    id: track.id,
    title: track.title,
    artists: "",
    coverUrl: track.cover?.url ?? "",
    durationMs: track.durationMs || 0,
    playCount: 0,
  }),
}));

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const PLAYLIST_ITEM = {
  id: "pl1",
  title: "Big",
  isPublic: false,
  revision: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  trackCount: 42,
  coverUrls: ["https://img/a"],
};

beforeEach(() => {
  localStorage.clear();
});

async function setup() {
  vi.resetModules();
  const mod = await import("./usePlaylists");
  const { api } = await import("@/shared/api");
  // The mocked api module can outlive resetModules in this
  // runner, so call counts are cleared here and asserted
  // relative to a per-test baseline below.
  (api.listPlaylists as any).mockClear();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  let state: ReturnType<typeof mod.usePlaylistsList> | undefined;
  function Probe() {
    state = mod.usePlaylistsList();
    return null;
  }
  return {
    mod,
    api,
    root,
    container,
    Probe,
    getState: () => state,
    teardown: () => {
      act(() => root.unmount());
      document.body.removeChild(container);
    },
  };
}

describe("retryPlaylistsLoad (S0 companion)", () => {
  it("re-runs the load after a failure and lands the playlists, error cleared", async () => {
    const { mod, api, root, Probe, getState, teardown } = await setup();
    (api.listPlaylists as any)
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue({ items: [PLAYLIST_ITEM] });

    act(() => root.render(<Probe />));
    await flush();
    await flush();

    expect(getState()?.error).toBeInstanceOf(Error);
    expect(getState()?.data.playlists).toHaveLength(0);
    const callsBeforeRetry = (api.listPlaylists as any).mock.calls.length;
    expect(callsBeforeRetry).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await mod.retryPlaylistsLoad();
    });
    await flush();

    expect((api.listPlaylists as any).mock.calls.length).toBe(
      callsBeforeRetry + 1,
    );
    expect(getState()?.error).toBeUndefined();
    expect(getState()?.data.playlists).toHaveLength(1);
    expect(getState()?.data.playlists[0]).toMatchObject({
      id: "pl1",
      trackCount: 42,
    });
    teardown();
  });

  it("keeps the error, honestly, when the retry fails again", async () => {
    const { mod, api, root, Probe, getState, teardown } = await setup();
    (api.listPlaylists as any).mockRejectedValue(new Error("still down"));

    act(() => root.render(<Probe />));
    await flush();
    await flush();

    expect(getState()?.error).toBeInstanceOf(Error);
    const callsBeforeRetry = (api.listPlaylists as any).mock.calls.length;
    expect(callsBeforeRetry).toBeGreaterThanOrEqual(1);

    await act(async () => {
      await mod.retryPlaylistsLoad();
    });
    await flush();

    expect((api.listPlaylists as any).mock.calls.length).toBe(
      callsBeforeRetry + 1,
    );
    expect(getState()?.error).toBeInstanceOf(Error);
    expect((getState()?.error as Error).message).toBe("still down");
    expect(getState()?.data.playlists).toHaveLength(0);
    teardown();
  });
});
