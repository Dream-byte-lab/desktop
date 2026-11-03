import { describe, expect, it } from "vitest";
import type { TrackAnalysis } from "./analyseTrack";
import {
  ADVENTUROUS_PROFILE,
  CONSERVATIVE_PROFILE,
  STANDARD_PROFILE,
} from "./decisionProfile";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { authorRecipe, type RecipeRequest } from "./transitionPlanner";

// The decision-profile threading (S5-3): authoring without a profile
// must be the pre-slice author byte for byte, and authoring under a
// different temperament must change the judgement in the directions
// the profile's numbers claim. (The S5-2 author suite, unmodified,
// pins the standard behaviour itself.)

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

describe("authorRecipe — profile threading", () => {
  it("no profile and the standard profile author identical recipes", () => {
    const request: RecipeRequest = {
      outgoing: analysis({
        sections: [
          {
            kind: "verse",
            startSec: 16,
            endSec: 64,
            startBeat: 32,
            endBeat: 128,
            meanRms: 0.3,
            vocalActivity: 0.4,
            confidence: 0.9,
          },
          {
            kind: "outro",
            startSec: 200,
            endSec: 240,
            startBeat: 400,
            endBeat: 480,
            meanRms: 0.1,
            vocalActivity: 0,
            confidence: 0.9,
          },
        ],
        outro: { startSec: 200, endSec: 240, startBeat: 400, endBeat: 480 },
        vocalActivity: vocalCurve(240, (t) => (t < 200 ? 0.8 : 0)),
      }),
      outgoingPositionSec: 60,
      incoming: analysis({
        audioHash: "hash-b",
        drops: [{ timeSec: 32, beat: 64, strength: 2.4 }],
        intro: { startSec: 0, endSec: 16, startBeat: 0, endBeat: 32 },
        vocalActivity: vocalCurve(240, (t) => (t < 16 ? 0 : 0.8)),
      }),
    };
    const unprofiled = authorRecipe(request);
    const standard = authorRecipe({ ...request, profile: STANDARD_PROFILE });
    expect(unprofiled).not.toBeNull();
    expect(standard).toEqual(unprofiled);
  });

  it("a 5% pair: standard and adventurous beatmatch by rate; conservative reaches it only as a rendition", () => {
    const request: RecipeRequest = {
      outgoing: analysis(),
      outgoingPositionSec: 60,
      incoming: analysis({
        audioHash: "hash-b",
        beatMap: {
          bpm: 120 / 1.05,
          firstBeatSec: 0,
          beatsPerBar: 4,
          durationSec: 240,
        },
      }),
    };
    const standard = authorRecipe({ ...request, profile: STANDARD_PROFILE });
    expect(standard).not.toBeNull();
    expect(standard!.overlap.beatmatched).toBe(true);
    // Inside standard's 6% rate cap: an ordinary rate beatmatch —
    // no rendition is spent where the deck's own rate suffices.
    expect(standard!.overlap.stretchB).toBeNull();

    const conservative = authorRecipe({
      ...request,
      profile: CONSERVATIVE_PROFILE,
    });
    expect(conservative).not.toBeNull();
    expect(conservative!.overlap.beatmatched).toBe(true);
    // Past conservative's 4% rate cap but inside its +8% rendition
    // ceiling: the beatmatch survives, as a rendition — flat rate
    // curve, no hold, no return glide.
    expect(conservative!.overlap.stretchB).toBeCloseTo(1.05, 6);
    expect(conservative!.automation.rateB.points).toEqual([
      { atMs: 0, value: 1 },
    ]);

    const adventurous = authorRecipe({
      ...request,
      profile: ADVENTUROUS_PROFILE,
    });
    expect(adventurous).not.toBeNull();
    expect(adventurous!.overlap.beatmatched).toBe(true);
    expect(adventurous!.overlap.stretchB).toBeNull();
  });

  it("a 10% pair: standard and adventurous stretch, conservative refuses the beatmatch entirely", () => {
    const request: RecipeRequest = {
      outgoing: analysis(),
      outgoingPositionSec: 60,
      incoming: analysis({
        audioHash: "hash-b",
        beatMap: {
          bpm: 120 / 1.1,
          firstBeatSec: 0,
          beatsPerBar: 4,
          durationSec: 240,
        },
      }),
    };
    const standard = authorRecipe({ ...request, profile: STANDARD_PROFILE });
    expect(standard).not.toBeNull();
    expect(standard!.overlap.beatmatched).toBe(true);
    expect(standard!.overlap.stretchB).toBeCloseTo(1.1, 6);

    const adventurous = authorRecipe({
      ...request,
      profile: ADVENTUROUS_PROFILE,
    });
    expect(adventurous).not.toBeNull();
    expect(adventurous!.overlap.beatmatched).toBe(true);
    // Past even adventurous's 9% rate cap — a rendition there too.
    expect(adventurous!.overlap.stretchB).toBeCloseTo(1.1, 6);

    const conservative = authorRecipe({
      ...request,
      profile: CONSERVATIVE_PROFILE,
    });
    // Past conservative's +8% ceiling: the pair changes family.
    expect(conservative?.overlap.beatmatched ?? false).toBe(false);
    expect(conservative?.overlap.stretchB ?? null).toBeNull();
  });

  it("the slow side is tighter: a −5% pair stretches only under conservative; −8% beatmatches only under adventurous, by rate", () => {
    const atRate = (rateB: number): RecipeRequest => ({
      outgoing: analysis(),
      outgoingPositionSec: 60,
      incoming: analysis({
        audioHash: "hash-b",
        beatMap: {
          bpm: 120 / rateB,
          firstBeatSec: 0,
          beatsPerBar: 4,
          durationSec: 240,
        },
      }),
    });

    // −5%: inside standard's rate cap (rate), past conservative's
    // rate cap but inside its −6% ceiling (rendition).
    const standard5 = authorRecipe({
      ...atRate(0.95),
      profile: STANDARD_PROFILE,
    });
    expect(standard5!.overlap.beatmatched).toBe(true);
    expect(standard5!.overlap.stretchB).toBeNull();
    const conservative5 = authorRecipe({
      ...atRate(0.95),
      profile: CONSERVATIVE_PROFILE,
    });
    expect(conservative5!.overlap.beatmatched).toBe(true);
    expect(conservative5!.overlap.stretchB).toBeCloseTo(0.95, 6);

    // −8%: past the −6% ceilings of standard and conservative both;
    // adventurous's −9% ceiling coincides with its 9% rate cap, so
    // it answers by rate — the down-side rendition reach adds
    // nothing there, by the caps' own numbers.
    const standard8 = authorRecipe({
      ...atRate(0.92),
      profile: STANDARD_PROFILE,
    });
    expect(standard8?.overlap.beatmatched ?? false).toBe(false);
    const adventurous8 = authorRecipe({
      ...atRate(0.92),
      profile: ADVENTUROUS_PROFILE,
    });
    expect(adventurous8!.overlap.beatmatched).toBe(true);
    expect(adventurous8!.overlap.stretchB).toBeNull();
  });

  it("blend lengths follow the profile: conservative shorter than standard on a quiet pair", () => {
    const quiet = (overrides: Partial<TrackAnalysis> = {}) =>
      analysis({
        vocalActivity: vocalCurve(240, () => 0),
        ...overrides,
      });
    const request: RecipeRequest = {
      outgoing: quiet(),
      outgoingPositionSec: 60,
      incoming: quiet({ audioHash: "hash-b" }),
    };
    const standard = authorRecipe({ ...request, profile: STANDARD_PROFILE });
    const conservative = authorRecipe({
      ...request,
      profile: CONSERVATIVE_PROFILE,
    });
    expect(standard).not.toBeNull();
    expect(conservative).not.toBeNull();
    expect(standard!.preset).toBe("beatmatched-fade");
    expect(conservative!.preset).toBe("beatmatched-fade");
    // A quiet, matched, friendly pair earns each profile's LONG
    // blend: 24 beats standard, 16 conservative.
    expect(standard!.overlap.durationMs).toBeGreaterThan(
      conservative!.overlap.durationMs,
    );
  });
});
