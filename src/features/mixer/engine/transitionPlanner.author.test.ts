import { describe, expect, it } from "vitest";
import type { TrackAnalysis } from "./analyseTrack";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { validateRecipe } from "./recipe";
import { authorRecipe } from "./transitionPlanner";

// The S5-2 author, exercised against synthetic analysis-v2 fixtures
// with known structure: every assertion is a recipe field, so the
// evidence→choice mapping is pinned down as data.

function key(
  camelot: string,
  pitchClass: number,
  mode: "major" | "minor" = "major",
): KeyEstimate {
  return { tonic: "C", mode, pitchClass, camelot, confidence: 0.9 };
}

function analysis(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: "hash-a",
    ...overrides,
  };
}

/** A vocal curve at one reading per 0.25 s across the whole track. */
function vocalCurve(
  durationSec: number,
  activityAt: (t: number) => number,
  confidence = 1,
): VocalActivityCurve {
  const points = [];
  for (let t = 0; t < durationSec; t += 0.25) {
    points.push({ timeSec: t, activity: activityAt(t), confidence });
  }
  return { windowSec: 0.25, stepSec: 0.25, points };
}

const outgoing = (overrides: Partial<TrackAnalysis> = {}) =>
  analysis(overrides);
const incoming = (overrides: Partial<TrackAnalysis> = {}) =>
  analysis({ audioHash: "hash-b", ...overrides });

describe("authorRecipe — entries and exits from structure", () => {
  it("enters on the strongest usable drop, not the earliest", () => {
    const recipe = authorRecipe({
      outgoing: outgoing(),
      outgoingPositionSec: 60,
      incoming: incoming({
        drops: [
          { timeSec: 32, beat: 64, strength: 2.6 },
          { timeSec: 8, beat: 16, strength: 1.8 },
        ],
      }),
    });
    expect(recipe).not.toBeNull();
    expect(recipe!.preset).toBe("beatmatched-fade");
    // Entry beat 64, blend 16 beats → B starts at beat 48 = 24 s.
    expect(recipe!.overlap.startBMs).toBe(24_000);
    expect(recipe!.evidence.entryReason).toContain("strongest usable drop");
    expect(validateRecipe(recipe!)).toEqual([]);
    expect(recipe!.fingerprints).toEqual({
      aAudioHash: "hash-a",
      bAudioHash: "hash-b",
      analysisVersion: 2,
    });
    expect(recipe!.fallback.kind).toBe("cut");
  });

  it("enters at the intro's end when there is no drop", () => {
    const recipe = authorRecipe({
      outgoing: outgoing(),
      outgoingPositionSec: 60,
      incoming: incoming({
        intro: { startSec: 0, endSec: 16, startBeat: 0, endBeat: 32 },
      }),
    });
    expect(recipe).not.toBeNull();
    // Entry beat 32, blend 16 → B starts at beat 16 = 8 s.
    expect(recipe!.overlap.startBMs).toBe(8_000);
    expect(recipe!.evidence.entryReason).toContain("intro");
  });

  it("exits at the outro's first beat when one is ahead", () => {
    const recipe = authorRecipe({
      outgoing: outgoing({
        outro: { startSec: 100, endSec: 120, startBeat: 200, endBeat: 240 },
      }),
      outgoingPositionSec: 60,
      incoming: incoming(),
    });
    expect(recipe).not.toBeNull();
    expect(recipe!.overlap.startAMs).toBe(100_000);
    expect(recipe!.evidence.exitReason).toContain("outro");
  });

  it("still authors a sane recipe from a v1-shaped analysis (no v2 structure)", () => {
    const bare = incoming();
    delete bare.analysisVersion;
    delete bare.audioHash;
    const recipe = authorRecipe({
      outgoing: outgoing(),
      outgoingPositionSec: 60,
      incoming: bare,
    });
    expect(recipe).not.toBeNull();
    expect(recipe!.preset).toBe("beatmatched-fade");
    expect(validateRecipe(recipe!)).toEqual([]);
    expect(recipe!.fingerprints.bAudioHash).toBeNull();
  });
});

describe("authorRecipe — the graded vocal referee", () => {
  it("shortens the blend when two trusted voices would clash early in the window", () => {
    // A sings until 68 s; the natural window is A [64, 72]. B sings
    // throughout its window. Shortening to 12 beats moves A's window
    // to [66, 72], where only a third of it is sung.
    const recipe = authorRecipe({
      outgoing: outgoing({
        vocalActivity: vocalCurve(240, (t) => (t < 68 ? 1 : 0)),
      }),
      outgoingPositionSec: 60,
      incoming: incoming({
        drops: [{ timeSec: 16, beat: 32, strength: 2 }],
        vocalActivity: vocalCurve(240, () => 1),
      }),
    });
    expect(recipe).not.toBeNull();
    expect(recipe!.preset).toBe("beatmatched-fade");
    expect(recipe!.overlap.durationMs).toBe(6_000); // 12 beats at 120 bpm
    expect(recipe!.evidence.refereeShortened).toBe(true);
    expect(recipe!.evidence.vocalEvidence).toBe("trusted");
    expect(recipe!.evidence.vocalOverlap).toBeLessThanOrEqual(0.4);
  });

  it("does not shorten when only one side is singing", () => {
    const recipe = authorRecipe({
      outgoing: outgoing({ vocalActivity: vocalCurve(240, () => 1) }),
      outgoingPositionSec: 60,
      incoming: incoming({
        drops: [{ timeSec: 16, beat: 32, strength: 2 }],
        vocalActivity: vocalCurve(240, () => 0),
      }),
    });
    expect(recipe).not.toBeNull();
    expect(recipe!.overlap.durationMs).toBe(8_000); // the full 16 beats
    expect(recipe!.evidence.refereeShortened).toBe(false);
  });

  it("does not chase an uncertain reading: section-only evidence shortens at most one step and reverts if it does not clear", () => {
    const sungSection = {
      kind: "verse" as const,
      startSec: 0,
      endSec: 240,
      startBeat: 0,
      endBeat: 480,
      meanRms: 0.5,
      vocalActivity: 1,
      confidence: 0.9,
    };
    const recipe = authorRecipe({
      outgoing: outgoing({ sections: [sungSection] }),
      outgoingPositionSec: 60,
      incoming: incoming({ sections: [sungSection] }),
    });
    expect(recipe).not.toBeNull();
    // The blend survives at full length: the evidence is ungraded,
    // so the family is not changed and the shortening is not kept.
    expect(recipe!.preset).toBe("beatmatched-fade");
    expect(recipe!.overlap.durationMs).toBe(8_000);
    expect(recipe!.evidence.vocalEvidence).toBe("uncertain");
    expect(recipe!.evidence.refereeShortened).toBe(false);
  });
});

describe("authorRecipe — tempo and key teeth", () => {
  it("refuses to beatmatch beyond the stretch cap and cuts onto the drop instead", () => {
    const recipe = authorRecipe({
      outgoing: outgoing(),
      outgoingPositionSec: 60,
      incoming: incoming({
        beatMap: {
          bpm: 140,
          firstBeatSec: 0,
          beatsPerBar: 4,
          durationSec: 240,
        },
        drops: [{ timeSec: 13.7, beat: 32, strength: 2.2 }],
      }),
    });
    expect(recipe).not.toBeNull();
    expect(recipe!.preset).toBe("cut");
    expect(recipe!.overlap.beatmatched).toBe(false);
    expect(recipe!.overlap.rateB).toBe(1);
    expect(recipe!.evidence.tempoStretch).toBeCloseTo(
      Math.abs(120 / 140 - 1),
      6,
    );
  });

  it("refuses to beatmatch on a tempo guess (low tempo confidence)", () => {
    const recipe = authorRecipe({
      outgoing: outgoing(),
      outgoingPositionSec: 60,
      incoming: incoming({
        tempoConfidence: 0.1,
        drops: [{ timeSec: 16, beat: 32, strength: 2.2 }],
      }),
    });
    expect(recipe).not.toBeNull();
    expect(recipe!.preset).toBe("cut");
    expect(recipe!.overlap.beatmatched).toBe(false);
  });

  it("beatmatches the drop-cut itself when the tempo evidence allows", () => {
    // The blend is impossible here: the outgoing is nearly over, so
    // no phrase exit ahead of the playhead can hold one. Only the
    // drop-cut remains — and with matched tempos it is a
    // beatmatched cut.
    const recipe = authorRecipe({
      outgoing: outgoing({
        beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 76 },
      }),
      outgoingPositionSec: 70,
      incoming: incoming({
        drops: [{ timeSec: 16, beat: 32, strength: 2.2 }],
      }),
    });
    expect(recipe).not.toBeNull();
    expect(recipe!.preset).toBe("beatmatched-cut");
    expect(recipe!.overlap.durationMs).toBe(1_000); // 2 beats at 120 bpm
    expect(recipe!.overlap.beatmatched).toBe(true);
  });

  it("caps the blend at 8 beats for a distant key", () => {
    const quiet = vocalCurve(240, () => 0);
    const recipe = authorRecipe({
      outgoing: outgoing({ vocalActivity: quiet }),
      outgoingPositionSec: 60,
      incoming: incoming({
        beatMap: {
          bpm: 118,
          firstBeatSec: 0,
          beatsPerBar: 4,
          durationSec: 240,
        },
        key: key("2B", 6),
        vocalActivity: quiet,
      }),
    });
    expect(recipe).not.toBeNull();
    expect(recipe!.preset).toBe("beatmatched-fade");
    expect(recipe!.overlap.durationMs).toBeCloseTo(4_000, 0); // 8 beats of A
    expect(recipe!.evidence.keyScore).toBe(0.1);
  });
});

describe("authorRecipe — structure in the details", () => {
  it("chooses the rate return from the incoming's next section, not one fixed phrase", () => {
    const recipe = authorRecipe({
      outgoing: outgoing(),
      outgoingPositionSec: 60,
      incoming: incoming({
        beatMap: {
          bpm: 125,
          firstBeatSec: 0,
          beatsPerBar: 4,
          durationSec: 240,
        },
        drops: [{ timeSec: 15.36, beat: 32, strength: 2 }],
        sections: [
          {
            kind: "chorus",
            startSec: 19.2,
            endSec: 60,
            startBeat: 40,
            endBeat: 125,
            meanRms: 0.5,
            vocalActivity: 0,
            confidence: 0.9,
          },
        ],
      }),
    });
    expect(recipe).not.toBeNull();
    const rate = recipe!.automation.rateB;
    const last = rate.points[rate.points.length - 1];
    // Entry 32 → next section at 40: an 8-beat return at 125 bpm
    // (3.84 s), where v1's fixed glide was a full phrase (7.68 s).
    expect(last.atMs).toBeCloseTo(recipe!.overlap.durationMs + 3_840, 0);
    expect(last.value).toBe(1);
  });

  it("extends a short outgoing with a loop instead of shrinking the join", () => {
    const recipe = authorRecipe({
      outgoing: outgoing({
        beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 76 },
        sections: [
          {
            kind: "breakdown",
            startSec: 60,
            endSec: 76,
            startBeat: 120,
            endBeat: 152,
            meanRms: 0.3,
            vocalActivity: 0,
            confidence: 0.9,
          },
        ],
      }),
      outgoingPositionSec: 68,
      incoming: incoming({
        drops: [{ timeSec: 16, beat: 32, strength: 2 }],
      }),
    });
    expect(recipe).not.toBeNull();
    expect(recipe!.preset).toBe("beatmatched-fade");
    expect(recipe!.overlap.startAMs).toBe(72_000); // exit inside the breakdown
    expect(recipe!.overlap.durationMs).toBe(8_000); // the full 16 beats survive
    expect(recipe!.loops).toHaveLength(1);
    expect(recipe!.loops[0]).toMatchObject({
      type: "loop",
      side: "A",
      startMs: 60_000,
      endMs: 76_000,
    });
    expect(recipe!.evidence.exitReason).toContain("loop");
    expect(validateRecipe(recipe!)).toEqual([]);
  });
});
