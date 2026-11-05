import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";
import { api } from "@/shared/api";
import { playerEngine } from "./playerEngine";
import { usePlayerStore } from "../store/playerStore";
import { useDjState } from "@/features/mixer/liverave/state";
import { recordListen } from "@/features/mixer/engine/tasteTracker";
import { ANALYSIS_VERSION } from "@/features/mixer/liverave/analyse";
import type { TrackRead } from "@/features/mixer/liverave/facts";
import { putRead, recordTrackHash } from "@/features/mixer/liverave/storage";

// Engine-level Smart Shuffle: mode transitions on a live queue,
// the activation rule from the 2026-11-05 user ruling (smart
// lives only while shuffle is on; off removes guests and restores
// the natural order exactly), the DJ-intent gate, the feature
// switch, and the guest pass end to end (rails → admission →
// weave) with the catalogue and the analysis store stubbed at
// their real seams.

const track = (id: string, artists = `Artist ${id}`): Track => ({
  id,
  title: `Song ${id}`,
  artists,
  coverUrl: `https://example.com/${id}.jpg`,
  durationMs: 180_000,
  playCount: 0,
});

function fakeRead(trackId: string): TrackRead {
  return {
    audioHash: `hash-${trackId}`,
    analysisVersion: ANALYSIS_VERSION,
    depth: "deep",
    durationSec: 180,
    bpm: 120,
    tempoConfidence: 0.9,
    grid: { beatsMs: [], downbeatsMs: [], beatsPerBar: 4, confidence: 0.5 },
    key: null,
    sections: [],
    energyCurvePerSec: [],
    energyContour: [],
    vocalActivity: [],
    drops: [],
    loudnessRms: 0.2,
  };
}

/** Seeds the new engine's store the way its source path does: the
 * read itself, plus the trackId → audioHash bridge entry. */
async function seedRead(trackId: string): Promise<void> {
  await putRead(fakeRead(trackId));
  await recordTrackHash(trackId, `hash-${trackId}`);
}

const ids = (tracks: readonly Track[]) => tracks.map((t) => t.id);

function resetPlayer() {
  useDjState.setState({ intent: false, active: false });
  usePlayerStore.setState({
    status: "idle",
    queue: [],
    currentIndex: -1,
    currentTrack: null,
    positionMs: 0,
    durationMs: 0,
    repeat: "off",
    shuffle: false,
    shuffleMode: "off",
    smartShuffleEnabled: true,
    smartGuestIds: [],
    error: null,
  });
  playerEngine.clearQueue();
}

describe("Smart Shuffle engine integration", () => {
  beforeEach(() => {
    resetPlayer();
    vi.spyOn(api, "getRadio").mockResolvedValue({ items: [] } as never);
    vi.spyOn(api, "search").mockResolvedValue({ items: [] } as never);
  });

  it("cycles off → smart → plain → off, pinning the current track and restoring the natural order exactly", async () => {
    const playlist = Array.from({ length: 10 }, (_, i) => track(`p-${i}`));
    await playerEngine.playTrack(playlist[0], playlist);

    playerEngine.cycleShuffleMode();
    let state = usePlayerStore.getState();
    expect(state.shuffleMode).toBe("smart");
    expect(state.shuffle).toBe(true);
    expect(state.queue[0]?.id).toBe("p-0");
    expect(new Set(ids(state.queue))).toEqual(new Set(ids(playlist)));

    playerEngine.cycleShuffleMode();
    state = usePlayerStore.getState();
    expect(state.shuffleMode).toBe("plain");
    expect(new Set(ids(state.queue))).toEqual(new Set(ids(playlist)));

    playerEngine.cycleShuffleMode();
    state = usePlayerStore.getState();
    expect(state.shuffleMode).toBe("off");
    expect(state.shuffle).toBe(false);
    expect(ids(state.queue)).toEqual(ids(playlist));
  });

  it("the legacy setShuffle seam rolls plain and restores, never inventing a smart selection", async () => {
    const playlist = Array.from({ length: 8 }, (_, i) => track(`s-${i}`));
    await playerEngine.playTrack(playlist[0], playlist);

    playerEngine.setShuffle(true);
    let state = usePlayerStore.getState();
    expect(state.shuffleMode).toBe("plain");
    expect(new Set(ids(state.queue))).toEqual(new Set(ids(playlist)));

    playerEngine.setShuffle(false);
    state = usePlayerStore.getState();
    expect(state.shuffleMode).toBe("off");
    expect(ids(state.queue)).toEqual(ids(playlist));
  });

  it("re-selecting smart re-rolls: still smart, still a full permutation, current track pinned", async () => {
    const playlist = Array.from({ length: 9 }, (_, i) => track(`r-${i}`));
    await playerEngine.playTrack(playlist[0], playlist);
    playerEngine.setShuffleMode("smart");
    playerEngine.setShuffleMode("smart");
    const state = usePlayerStore.getState();
    expect(state.shuffleMode).toBe("smart");
    expect(state.queue[0]?.id).toBe("r-0");
    expect(new Set(ids(state.queue))).toEqual(new Set(ids(playlist)));
  });

  it("with the feature disabled in Settings, the cycle skips smart entirely", async () => {
    const playlist = Array.from({ length: 6 }, (_, i) => track(`d-${i}`));
    await playerEngine.playTrack(playlist[0], playlist);
    usePlayerStore.getState().setSmartShuffleEnabled(false);

    playerEngine.cycleShuffleMode();
    expect(usePlayerStore.getState().shuffleMode).toBe("plain");
    playerEngine.cycleShuffleMode();
    expect(usePlayerStore.getState().shuffleMode).toBe("off");
    usePlayerStore.getState().setSmartShuffleEnabled(true);
  });

  it("disabling the feature while smart is live ends smart through the off transition", async () => {
    const playlist = Array.from({ length: 8 }, (_, i) => track(`f-${i}`));
    await playerEngine.playTrack(playlist[0], playlist);
    playerEngine.setShuffleMode("smart");
    expect(usePlayerStore.getState().shuffleMode).toBe("smart");

    usePlayerStore.getState().setSmartShuffleEnabled(false);
    const state = usePlayerStore.getState();
    expect(state.shuffleMode).toBe("off");
    expect(state.shuffle).toBe(false);
    expect(ids(state.queue)).toEqual(ids(playlist));
    usePlayerStore.getState().setSmartShuffleEnabled(true);
  });

  it("with DJ intent on, enabling smart does not reorder the queue — the brain sequences", async () => {
    const playlist = Array.from({ length: 8 }, (_, i) => track(`j-${i}`));
    await playerEngine.playTrack(playlist[0], playlist);
    useDjState.setState({ intent: true });
    playerEngine.setShuffleMode("smart");
    const state = usePlayerStore.getState();
    expect(state.shuffleMode).toBe("smart");
    // Plain-playback ordering is suppressed under DJ intent: the
    // queue the session starts from keeps the playlist's order.
    expect(ids(state.queue)).toEqual(ids(playlist));
    useDjState.setState({ intent: false });
  });

  it("cold start honesty: rails full of fitting songs still admit NO guests while the taste profile is thin", async () => {
    const playlist = Array.from({ length: 8 }, (_, i) => track(`c-${i}`));
    const guests = [
      track("cg-1", "Guest Artist"),
      track("cg-2", "Guest Artist"),
    ];
    for (const t of [...playlist, ...guests]) {
      await seedRead(t.id);
    }
    vi.spyOn(api, "getRadio").mockResolvedValue({
      items: guests,
    } as never);

    await playerEngine.playTrack(playlist[0], playlist);
    playerEngine.setShuffleMode("smart");
    // Give the guest pass every chance to land.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const state = usePlayerStore.getState();
    expect(state.smartGuestIds).toEqual([]);
    expect(ids(state.queue)).not.toContain("cg-1");
    expect(ids(state.queue)).not.toContain("cg-2");
  });

  it("admits fit-tested guests as a labelled minority, and switching off removes them and restores the playlist exactly", async () => {
    // A real taste profile: completed listens build it.
    const loved = track("loved-1", "Guest Artist");
    recordListen({ track: loved, playedRatio: 1, completed: true });
    recordListen({
      track: track("loved-2", "Guest Artist"),
      playedRatio: 1,
      completed: true,
    });

    const playlist = Array.from({ length: 8 }, (_, i) => track(`g-${i}`));
    const guestPool = Array.from({ length: 4 }, (_, i) =>
      track(`gg-${i}`, "Guest Artist"),
    );
    for (const t of [...playlist, ...guestPool]) {
      await seedRead(t.id);
    }
    vi.spyOn(api, "getRadio").mockResolvedValue({
      items: guestPool,
    } as never);

    await playerEngine.playTrack(playlist[0], playlist);
    playerEngine.setShuffleMode("smart");

    await vi.waitFor(
      () => {
        expect(usePlayerStore.getState().smartGuestIds.length).toBe(2);
      },
      { timeout: 2_000, interval: 10 },
    );

    const state = usePlayerStore.getState();
    // Bound: 7 playlist tracks upcoming → at most floor(7/3) = 2
    // guests, i.e. never more than one guest in four overall.
    expect(state.smartGuestIds).toHaveLength(2);
    for (const guestId of state.smartGuestIds) {
      expect(ids(state.queue)).toContain(guestId);
      expect(ids(playlist)).not.toContain(guestId);
    }
    // The playlist stays the body of the set: every member present.
    for (const member of playlist) {
      expect(ids(state.queue)).toContain(member.id);
    }
    // A guest never takes the first upcoming slot.
    expect(state.smartGuestIds).not.toContain(state.queue[1]?.id);

    playerEngine.setShuffleMode("off");
    const restored = usePlayerStore.getState();
    expect(restored.smartGuestIds).toEqual([]);
    expect(ids(restored.queue)).toEqual(ids(playlist));
  });
});
