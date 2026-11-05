// Playlist intelligence (R6) — the pure layer, proven without
// ears: the minimum-play floor's exact definition (Note 19,
// ruling 1), intro/outro suitability, the whole-playlist
// picture (known vs pending, energy groups, transition
// clusters), §14.1 track-candidate scoring with R4's
// shared-label credit, and the buy-time loop span (ruling 2's
// musical raw material).

import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import type { KeyEstimate } from "./detectKey";
import {
  buildPlaylistIntel,
  buyTimeLoopSpan,
  factsFromAnalysis,
  introSuitability,
  minimumPlayEndSec,
  outroSuitability,
  trackFitScore,
  type TrackFacts,
} from "./playlistIntel";
import type { PreparedTrack } from "./trackSource";

function key(camelot: string, pitchClass: number): KeyEstimate {
  return { tonic: "C", mode: "major", pitchClass, camelot, confidence: 0.9 };
}

function section(
  kind: TrackSection["kind"],
  startSec: number,
  endSec: number,
  meanRms: number,
  vocalActivity = 0,
): TrackSection {
  return {
    kind,
    startSec,
    endSec,
    startBeat: startSec * 2,
    endBeat: endSec * 2,
    meanRms,
    vocalActivity,
    confidence: 0.9,
  };
}

function analysis(
  overrides: Partial<TrackAnalysis> & { durationSec?: number } = {},
): TrackAnalysis {
  const { durationSec = 240, ...rest } = overrides;
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: "hash-x",
    ...rest,
  } as TrackAnalysis;
}

function prepared(
  id: string,
  trackAnalysis: TrackAnalysis,
  mixable = true,
): PreparedTrack {
  return {
    track: {
      id,
      title: id,
      artists: "Test Artist",
      durationMs: 240_000,
    } as Track,
    buffer: { duration: 240 } as unknown as AudioBuffer,
    analysis: trackAnalysis,
    mixable,
  };
}

function facts(overrides: Partial<TrackFacts> = {}): TrackFacts {
  return {
    trackId: "t",
    audioHash: "hash-t",
    bpm: 120,
    key: key("8B", 0),
    energy: 0.5,
    tempoConfidence: 0.9,
    vocalDensity: null,
    introSuitability: 0.5,
    outroSuitability: 0.5,
    minimumPlayEndSec: null,
    durationSec: 240,
    ...overrides,
  };
}

describe("minimumPlayEndSec — the musical floor (Note 19, ruling 1)", () => {
  it("is the end of the first chorus", () => {
    const a = analysis({
      sections: [
        section("intro", 0, 16, 0.15),
        section("verse", 16, 64, 0.3),
        section("chorus", 64, 112, 0.5),
        section("verse", 112, 200, 0.3),
        section("outro", 200, 240, 0.1),
      ],
    });
    expect(minimumPlayEndSec(a)).toBe(112);
  });

  it("a drop is a big section too — the first big section wins", () => {
    const a = analysis({
      sections: [
        section("intro", 0, 16, 0.15),
        section("drop", 16, 48, 0.5),
        section("chorus", 48, 96, 0.5),
      ],
    });
    expect(minimumPlayEndSec(a)).toBe(48);
  });

  it("with no chorus or drop, the floor is the first section's end", () => {
    const a = analysis({
      sections: [section("intro", 0, 16, 0.15), section("verse", 16, 64, 0.3)],
    });
    expect(minimumPlayEndSec(a)).toBe(16);
  });

  it("derives the floor from the track's proportions without usable sections (Note 33)", () => {
    // The fixture track is 240 s: a quarter of it is the floor.
    expect(minimumPlayEndSec(analysis({ sections: [] }))).toBe(60);
    expect(minimumPlayEndSec(analysis({ sections: undefined }))).toBe(60);
    const broken = analysis({ sections: [section("chorus", 0, 0, 0.5)] });
    expect(minimumPlayEndSec(broken)).toBe(60);
  });

  it("the derived floor scales with the track and is capped (Note 33)", () => {
    // A 30 s interlude derives 7.5 s — owed a hearing, never trapped.
    expect(minimumPlayEndSec(analysis({ durationSec: 30, sections: [] }))).toBe(
      7.5,
    );
    // A 10-minute track derives the 90 s cap, not a quarter of itself.
    expect(
      minimumPlayEndSec(analysis({ durationSec: 600, sections: [] })),
    ).toBe(90);
  });

  it("a trivially short first section is raised to the derived floor (Note 33)", () => {
    const a = analysis({
      sections: [section("intro", 0, 4, 0.15), section("verse", 4, 240, 0.3)],
    });
    expect(minimumPlayEndSec(a)).toBe(60);
  });

  it("a genuine short first section at the trivial bound stands (Note 33)", () => {
    const a = analysis({
      sections: [section("intro", 0, 10, 0.15), section("verse", 10, 240, 0.3)],
    });
    expect(minimumPlayEndSec(a)).toBe(10);
  });

  it("abstains (null) only when the track's length itself is unknown", () => {
    expect(
      minimumPlayEndSec(analysis({ durationSec: 0, sections: [] })),
    ).toBeNull();
    expect(
      minimumPlayEndSec(analysis({ durationSec: 0, sections: undefined })),
    ).toBeNull();
  });

  it("never exceeds the track's duration", () => {
    const a = analysis({
      durationSec: 100,
      sections: [section("chorus", 40, 300, 0.5)],
    });
    expect(minimumPlayEndSec(a)).toBe(100);
  });
});

describe("intro / outro suitability", () => {
  it("declared bounds of at least a second read 0.85", () => {
    const a = analysis({
      intro: { startSec: 0, endSec: 16, startBeat: 0, endBeat: 32 },
      outro: { startSec: 200, endSec: 240, startBeat: 400, endBeat: 480 },
      sections: [section("verse", 0, 240, 0.5)],
    });
    expect(introSuitability(a)).toBe(0.85);
    expect(outroSuitability(a)).toBe(0.85);
  });

  it("an intro/outro-labelled edge section reads 0.8", () => {
    const a = analysis({
      sections: [
        section("intro", 0, 16, 0.15),
        section("verse", 16, 200, 0.5),
        section("outro", 200, 240, 0.1),
      ],
    });
    expect(introSuitability(a)).toBe(0.8);
    expect(outroSuitability(a)).toBe(0.8);
  });

  it("a quiet edge against a loud peak reads 0.55; a full-tilt edge reads 0.35", () => {
    const quiet = analysis({
      sections: [section("verse", 0, 60, 0.1), section("chorus", 60, 240, 0.5)],
    });
    expect(introSuitability(quiet)).toBe(0.55);
    expect(outroSuitability(quiet)).toBe(0.35);
    const loud = analysis({
      sections: [
        section("chorus", 0, 180, 0.5),
        section("verse", 180, 240, 0.45),
      ],
    });
    expect(introSuitability(loud)).toBe(0.35);
  });

  it("is null without sections or bounds — unknown, never guessed", () => {
    expect(introSuitability(analysis({ sections: [] }))).toBeNull();
    expect(outroSuitability(analysis({ sections: undefined }))).toBeNull();
  });
});

describe("factsFromAnalysis", () => {
  it("carries hash, energy, floor, duration and the owner's labels", () => {
    const a = analysis({
      audioHash: "hash-song",
      sections: [
        section("intro", 0, 16, 0.15),
        section("chorus", 16, 64, 0.175),
      ],
    });
    const f = factsFromAnalysis("song", a, { playlistGenres: ["Warm Up"] });
    expect(f.audioHash).toBe("hash-song");
    expect(f.energy).toBeCloseTo(0.5); // chorus peak 0.175 / 0.35 reference
    expect(f.minimumPlayEndSec).toBe(64);
    expect(f.durationSec).toBe(240);
    expect(f.playlistGenres).toEqual(["Warm Up"]);
  });
});

describe("buildPlaylistIntel — the progressive whole-playlist picture", () => {
  function energyAnalysis(energy: number, bpm = 120): TrackAnalysis {
    return analysis({
      beatMap: { bpm, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
      sections: [section("chorus", 0, 240, energy * 0.35)],
    });
  }

  it("separates the known from the pending — a shell is pending, not known", () => {
    const intel = buildPlaylistIntel([
      { trackId: "known", prepared: prepared("known", energyAnalysis(0.5)) },
      {
        trackId: "shell",
        prepared: prepared("shell", energyAnalysis(0.5), false),
      },
      { trackId: "waiting", prepared: null },
    ]);
    expect(intel.knownTrackIds).toEqual(["known"]);
    expect(intel.pendingTrackIds).toEqual(["shell", "waiting"]);
    expect(intel.factsById.has("shell")).toBe(false);
  });

  it("groups known tracks by absolute energy and averages the picture", () => {
    const intel = buildPlaylistIntel([
      { trackId: "low", prepared: prepared("low", energyAnalysis(0.2)) },
      { trackId: "mid", prepared: prepared("mid", energyAnalysis(0.5)) },
      { trackId: "high", prepared: prepared("high", energyAnalysis(0.7)) },
      { trackId: "peak", prepared: prepared("peak", energyAnalysis(0.9)) },
    ]);
    expect(intel.energyGroups.low).toEqual(["low"]);
    expect(intel.energyGroups.mid).toEqual(["mid"]);
    expect(intel.energyGroups.high).toEqual(["high"]);
    expect(intel.energyGroups.peak).toEqual(["peak"]);
    expect(intel.meanBpm).toBe(120);
    expect(intel.meanEnergy).toBeCloseTo(0.575);
  });

  it("clusters tempo/key-compatible tracks and leaves the far track out", () => {
    const intel = buildPlaylistIntel([
      { trackId: "a", prepared: prepared("a", energyAnalysis(0.5, 120)) },
      { trackId: "b", prepared: prepared("b", energyAnalysis(0.5, 122)) },
      { trackId: "far", prepared: prepared("far", energyAnalysis(0.5, 90)) },
    ]);
    const clusterOf = (id: string) =>
      intel.clusters.find((group) => group.includes(id));
    expect(clusterOf("a")).toEqual(expect.arrayContaining(["a", "b"]));
    expect(clusterOf("far")).toBeUndefined();
  });
});

describe("trackFitScore — §14.1 spent on tracks", () => {
  const context = { arcTargetEnergy: 0.5, sharedLabelCredit: 0.6 };

  it("a twin of the current track at the arc target scores high", () => {
    const fit = trackFitScore(facts(), facts({ trackId: "u" }), context);
    expect(fit.parts.tempo).toBe(1);
    expect(fit.parts.energy).toBe(1);
    expect(fit.score).toBeGreaterThan(0.8);
  });

  it("genre reads the owner's Playlist Genre through the shared-label credit", () => {
    const current = facts({ playlistGenres: ["Warm Up"] });
    const shared = facts({ trackId: "s", playlistGenres: ["Warm Up"] });
    const other = facts({ trackId: "o", playlistGenres: ["Peak Time"] });
    expect(trackFitScore(current, shared, context).parts.genre).toBe(0.6);
    expect(trackFitScore(current, other, context).parts.genre).toBe(0.4);
    // Bent below a half (Open Format), roaming wins instead.
    const bent = { arcTargetEnergy: 0.5, sharedLabelCredit: 0.25 };
    expect(trackFitScore(current, shared, bent).parts.genre).toBe(0.25);
    expect(trackFitScore(current, other, bent).parts.genre).toBe(0.75);
  });

  it("labelless pairs read the neutral genre 0.5", () => {
    expect(
      trackFitScore(facts(), facts({ trackId: "u" }), context).parts.genre,
    ).toBe(0.5);
  });

  it("an opener is judged on opening evidence alone — pair parts neutral", () => {
    const fit = trackFitScore(null, facts({ introSuitability: 0.85 }), context);
    expect(fit.parts.tempo).toBe(0.5);
    expect(fit.parts.key).toBe(0.5);
    expect(fit.parts.genre).toBe(0.5);
    expect(fit.parts.structure).toBe(0.85);
  });
});

describe("buyTimeLoopSpan — ruling 2's raw material", () => {
  function gridded(durationSec: number, stepSec = 0.5): TrackAnalysis {
    const anchors = [];
    for (let t = 0; t <= durationSec; t += stepSec) {
      anchors.push({ beat: t / stepSec, timeSec: t, confidence: 0.9 });
    }
    return analysis({
      durationSec,
      beatMap: {
        bpm: 120,
        firstBeatSec: 0,
        beatsPerBar: 4,
        durationSec,
        grid: {
          anchors,
          sections: [
            {
              startBeat: 0,
              endBeat: durationSec / stepSec,
              bpm: 120,
              confidence: 0.9,
            },
          ],
          confidence: 0.9,
        },
      },
    });
  }

  it("names the final 16 beats on the grid, ending at the track's end", () => {
    // 120 BPM: 16 beats = 8 s; the anchor at 22 s spans exactly that.
    expect(buyTimeLoopSpan(gridded(30))).toEqual({ startSec: 22, endSec: 30 });
  });

  it("abstains without a grid, on a short track, or with no anchor in range", () => {
    expect(buyTimeLoopSpan(analysis({ durationSec: 30 }))).toBeNull();
    expect(buyTimeLoopSpan(gridded(6))).toBeNull();
    const early = gridded(60);
    early.beatMap.grid = {
      anchors: [{ beat: 0, timeSec: 0, confidence: 0.9 }],
      sections: [],
      confidence: 0.9,
    };
    expect(buyTimeLoopSpan(early)).toBeNull();
  });
});
