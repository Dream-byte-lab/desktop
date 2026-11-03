import { describe, expect, it, beforeEach } from "vitest";
import { parseRawLyrics } from "./engine/lyricsParser";
import { useLyricsStore } from "./store/lyricsStore";
import type { LyricsCandidate } from "@/shared/contracts/lyrics";

// Regression pin for upstream issue #328 (offset appearing to accumulate
// across track changes, reported on Liner 0.2.10). These tests replay the
// issue through the REAL store using the exact payload shapes
// playerEngine.fetchLyricsForTrack sends:
//   1. a loading payload carrying currentLyricsTrackId + empty lines, then
//   2. candidate payloads carrying parsed lines and NO track id.

const LRC_A = "[00:10.00]Alpha line one\n[00:20.00]Alpha line two";
const LRC_B = "[00:10.00]Bravo line one\n[00:20.00]Bravo line two";
const LRC_C = "[00:10.00]Charlie line one\n[00:20.00]Charlie line two";

function loadingPayload(trackId: string) {
  useLyricsStore.getState().setLyricsState({
    lyricsLoading: true,
    lyricsError: null,
    rawLyrics: null,
    rawFormat: null,
    braccatoLyrics: [],
    syncedLines: [],
    plainLyrics: null,
    lyricsQuality: 0,
    currentLyricsTrackId: trackId,
    activeProvider: null,
    availableProviders: [],
  });
}

function candidatePayload(
  candidate: LyricsCandidate,
  availableProviders = [optionFor(candidate)],
) {
  const parsed = parseRawLyrics(
    candidate.lyrics.content,
    candidate.lyrics.format,
  );
  // mirrors the streaming branch of fetchLyricsForTrack: no track id
  useLyricsStore.getState().setLyricsState({
    activeProvider: candidate.provider,
    availableProviders,
    rawLyrics: candidate.lyrics.content,
    rawFormat: candidate.lyrics.format,
    braccatoLyrics: parsed.braccatoLyrics,
    syncedLines: parsed.syncedLines,
    plainLyrics: parsed.plainLyrics,
    lyricsQuality: candidate.quality.total,
  });
}

function makeCandidate(provider: string, content: string): LyricsCandidate {
  return {
    provider,
    contentKind: "line_synced",
    syncLevel: "line_level",
    quality: {
      total: 80,
      match: 20,
      content: 30,
      sync: 30,
      source: 0,
      reasons: [],
    },
    lyrics: { format: "lrc", content },
  };
}

function optionFor(candidate: LyricsCandidate) {
  return {
    provider: candidate.provider,
    syncLevel: candidate.syncLevel,
    quality: candidate.quality.total,
    candidate,
  };
}

// the LRC parser prepends an instrumental intro line at 0ms, so the
// offset assertions target the first sung line and its braccato twin
function firstLineMs(): number {
  const state = useLyricsStore.getState();
  return state.syncedLines.find((l) => l.text.trim().length > 0)?.timeMs ?? -1;
}

function firstBraccatoMs(): number {
  const state = useLyricsStore.getState();
  return (
    state.braccatoLyrics.find((l) => (l.words ?? "").trim().length > 0)
      ?.startTimeMs ?? -1
  );
}

function loadTrack(trackId: string, lrc: string, provider = "lrclib") {
  loadingPayload(trackId);
  candidatePayload(makeCandidate(provider, lrc));
}

describe("issue #328: lyrics offset must not accumulate across tracks", () => {
  beforeEach(() => {
    useLyricsStore.getState().reset();
    useLyricsStore.setState({ trackOffsets: {} });
  });

  it("replays the report: +200 on A, then B and C start unshifted at 0", () => {
    loadTrack("track-a", LRC_A);
    useLyricsStore.getState().setOffset(200);
    expect(useLyricsStore.getState().offsetMs).toBe(200);
    expect(firstLineMs()).toBe(10200);

    // song 2: in the report it was already off by ~2s before any touch
    loadTrack("track-b", LRC_B);
    expect(useLyricsStore.getState().offsetMs).toBe(0);
    expect(firstLineMs()).toBe(10000);
    expect(firstBraccatoMs()).toBe(10000);

    // the reporter then set ~+2200 on B; song 3 was off even more
    useLyricsStore.getState().setOffset(2200);
    expect(firstLineMs()).toBe(12200);

    loadTrack("track-c", LRC_C);
    expect(useLyricsStore.getState().offsetMs).toBe(0);
    expect(firstLineMs()).toBe(10000);
    expect(firstBraccatoMs()).toBe(10000);
  });

  it("applies the offset exactly once when a streaming candidate replaces lines on the same track", () => {
    loadTrack("track-a", LRC_A);
    useLyricsStore.getState().setOffset(300);
    expect(firstLineMs()).toBe(10300);

    // a better candidate streams in for the SAME track while offset is set
    candidatePayload(makeCandidate("kugou", LRC_B));
    expect(useLyricsStore.getState().offsetMs).toBe(300);
    expect(firstLineMs()).toBe(10300);

    // and a second replacement still applies it once, never twice
    candidatePayload(makeCandidate("lrclib", LRC_A));
    expect(firstLineMs()).toBe(10300);
  });

  it("applies the offset exactly once on selectProvider", () => {
    const lrclib = makeCandidate("lrclib", LRC_A);
    const kugou = makeCandidate("kugou", LRC_B);
    loadingPayload("track-a");
    candidatePayload(lrclib, [optionFor(lrclib), optionFor(kugou)]);

    useLyricsStore.getState().setOffset(250);
    expect(firstLineMs()).toBe(10250);

    useLyricsStore.getState().selectProvider("kugou");
    expect(useLyricsStore.getState().activeProvider).toBe("kugou");
    expect(useLyricsStore.getState().offsetMs).toBe(250);
    expect(firstLineMs()).toBe(10250);

    useLyricsStore.getState().selectProvider("lrclib");
    expect(firstLineMs()).toBe(10250);
  });

  it("keeps per-track memory: B's offset never leaks into A's stored +200", () => {
    loadTrack("track-a", LRC_A);
    useLyricsStore.getState().setOffset(200);

    loadTrack("track-b", LRC_B);
    useLyricsStore.getState().setOffset(700);
    expect(useLyricsStore.getState().trackOffsets["track-b"]).toBe(700);
    expect(firstLineMs()).toBe(10700);

    // back to A: exactly its own +200, not 200, not 900, not 700
    loadTrack("track-a", LRC_A);
    expect(useLyricsStore.getState().offsetMs).toBe(200);
    expect(firstLineMs()).toBe(10200);
    expect(useLyricsStore.getState().trackOffsets["track-a"]).toBe(200);
  });
});
