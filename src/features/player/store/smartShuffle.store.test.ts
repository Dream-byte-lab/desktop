import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_KEY = "liner_player_session_v2";

async function loadStore() {
  vi.resetModules();
  const mod = await import("./playerStore");
  const storage = await import("@/shared/utils/storage");
  return {
    usePlayerStore: mod.usePlayerStore,
    flush: storage.debouncedStorage.flush,
  };
}

describe("smart shuffle store state", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to mode off, the feature enabled, and no guests", async () => {
    const { usePlayerStore } = await loadStore();
    const state = usePlayerStore.getState();
    expect(state.shuffleMode).toBe("off");
    expect(state.shuffle).toBe(false);
    expect(state.smartShuffleEnabled).toBe(true);
    expect(state.smartGuestIds).toEqual([]);
  });

  it("keeps the legacy boolean shadow in step with the mode", async () => {
    const { usePlayerStore } = await loadStore();
    usePlayerStore.getState().setShuffleMode("smart");
    expect(usePlayerStore.getState().shuffle).toBe(true);
    usePlayerStore.getState().setShuffleMode("plain");
    expect(usePlayerStore.getState().shuffle).toBe(true);
    usePlayerStore.getState().setShuffleMode("off");
    expect(usePlayerStore.getState().shuffle).toBe(false);
  });

  it("setShuffle(true) from off means the plain roll, never a smart selection the user did not make", async () => {
    const { usePlayerStore } = await loadStore();
    usePlayerStore.getState().setShuffle(true);
    expect(usePlayerStore.getState().shuffleMode).toBe("plain");
    // …and it never downgrades a smart selection already in force.
    usePlayerStore.getState().setShuffleMode("smart");
    usePlayerStore.getState().setShuffle(true);
    expect(usePlayerStore.getState().shuffleMode).toBe("smart");
    usePlayerStore.getState().setShuffle(false);
    expect(usePlayerStore.getState().shuffleMode).toBe("off");
  });

  it("migrates a session persisted by a pre-Smart-Shuffle build: shuffle on meant the plain roll", async () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ state: { shuffle: true, volume: 0.5 }, version: 0 }),
    );
    const { usePlayerStore } = await loadStore();
    const state = usePlayerStore.getState();
    expect(state.shuffleMode).toBe("plain");
    expect(state.shuffle).toBe(true);
    expect(state.smartShuffleEnabled).toBe(true);
    expect(state.smartGuestIds).toEqual([]);
  });

  it("migrates a legacy shuffle-off session to mode off", async () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ state: { shuffle: false }, version: 0 }),
    );
    const { usePlayerStore } = await loadStore();
    expect(usePlayerStore.getState().shuffleMode).toBe("off");
  });

  it("keeps a persisted smart selection and the feature switch across a reload", async () => {
    const first = await loadStore();
    first.usePlayerStore.getState().setShuffleMode("smart");
    first.usePlayerStore.getState().setSmartShuffleEnabled(false);
    first.flush();

    const second = await loadStore();
    const state = second.usePlayerStore.getState();
    expect(state.shuffleMode).toBe("smart");
    expect(state.shuffle).toBe(true);
    expect(state.smartShuffleEnabled).toBe(false);
  });

  it("repairs an unrecognised persisted mode instead of trusting it", async () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        state: { shuffleMode: "banana", shuffle: true },
        version: 0,
      }),
    );
    const { usePlayerStore } = await loadStore();
    expect(usePlayerStore.getState().shuffleMode).toBe("plain");
  });
});
