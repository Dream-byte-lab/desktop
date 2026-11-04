import { describe, expect, it } from "vitest";
import {
  analyseTrack,
  type TrackAnalysis,
  type TrackSection,
} from "./analyseTrack";
import { candidatesForPair, type Candidate } from "./candidates";
import { CONSERVATIVE_PROFILE, STANDARD_PROFILE } from "./decisionProfile";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { scoreCandidates } from "./scoring";
import { authorRecipe, type RecipeRequest } from "./transitionPlanner";

// Note 27 (C2) — the confidence scale and the floors, pinned to
// MEASURED values (investigation/note27-c2-fix.md). The numbers in
// this file are not round inventions: 0.17 is what the analyser
// (centred-autocorrelation scale, analysis v3) reads on a real
// folk-rock recording; 0.03 sits in the measured guess band (white
// noise 0.00, arrhythmic bursts 0.04). Before the repair, the real
// recording and white noise both read ~0.33 on the uncentred
// scale, and the STANDARD floor of 0.20 sat inside the real band
// once pair-minimum evidence was taken — real libraries were
// vetoed wholesale while the veto claimed to target guesses.

function key(camelot: string, pitchClass: number): KeyEstimate {
  return { tonic: "C", mode: "major", pitchClass, camelot, confidence: 0.9 };
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

function section(
  kind: TrackSection["kind"],
  startSec: number,
  endSec: number,
  meanRms: number,
  vocalActivity: number,
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

function analysis(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 3,
    audioHash: "hash-a",
    ...overrides,
  };
}

/** The scoring suite's rich pair, with both tracks at one measured confidence. */
function pairAt(tempoConfidence: number): RecipeRequest {
  const outgoing = analysis({
    tempoConfidence,
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("verse", 16, 64, 0.3, 0.85),
      section("chorus", 64, 112, 0.5, 0.9),
      section("verse", 112, 200, 0.3, 0.85),
      section("outro", 200, 240, 0.1, 0),
    ],
    outro: { startSec: 200, endSec: 240, startBeat: 400, endBeat: 480 },
    vocalActivity: vocalCurve(240, (t) => (t < 16 ? 0 : t < 200 ? 0.9 : 0)),
  });
  const incoming = analysis({
    tempoConfidence,
    audioHash: "hash-b",
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("chorus", 16, 64, 0.5, 0.9),
      section("verse", 64, 160, 0.3, 0.85),
      section("chorus", 160, 240, 0.5, 0.9),
    ],
    intro: { startSec: 0, endSec: 16, startBeat: 0, endBeat: 32 },
    drops: [{ timeSec: 32, beat: 64, strength: 2.4 }],
    vocalActivity: vocalCurve(240, (t) => (t < 16 ? 0 : 0.9)),
  });
  return { outgoing, outgoingPositionSec: 60, incoming };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("note27 C2 — the repaired confidence statistic", () => {
  it(
    "white noise no longer reads as tempo evidence",
    { timeout: 60000 },
    () => {
      const rand = mulberry(91);
      const samples = new Float32Array(12 * 44100);
      for (let n = 0; n < samples.length; n += 1)
        samples[n] = (rand() * 2 - 1) * 0.4;
      const result = analyseTrack(samples, 44100);
      expect(result).not.toBeNull();
      // The uncentred statistic read this signal at 0.32 — the
      // same as a real song. Centred, a guess reads as a guess.
      expect(result!.tempoConfidence).toBeLessThan(0.1);
    },
  );

  it(
    "a clean click song still reads as strong tempo evidence",
    { timeout: 60000 },
    () => {
      const samples = new Float32Array(12 * 44100);
      for (let beat = 0; ; beat += 1) {
        const t = 0.25 + beat * 0.5;
        if (t >= 12) break;
        const start = Math.floor(t * 44100);
        const amp = beat % 4 === 0 ? 0.95 : 0.55;
        for (let n = 0; n < 512 && start + n < samples.length; n += 1) {
          samples[start + n] +=
            amp * Math.exp(-n / 60) * Math.sin((2 * Math.PI * 180 * n) / 44100);
        }
      }
      const result = analyseTrack(samples, 44100);
      expect(result).not.toBeNull();
      expect(result!.tempoConfidence).toBeGreaterThan(0.7);
    },
  );
});

describe("note27 C2 — realistically weak evidence authors joins again", () => {
  it("a pair at the measured real-song confidence (0.17) earns a beatmatched blend under STANDARD", () => {
    const recipe = authorRecipe(pairAt(0.17));
    expect(recipe).not.toBeNull();
    expect(recipe!.preset).toBe("beatmatched-fade");
    expect(recipe!.overlap.beatmatched).toBe(true);
  });

  it("the same pair's beatmatched candidates survive STANDARD scoring un-vetoed", () => {
    const candidates = candidatesForPair(pairAt(0.17));
    const beatmatched = candidates.filter((c) => c.evidence.beatmatched);
    expect(beatmatched.length).toBeGreaterThan(0);
    const result = scoreCandidates(candidates, {}, STANDARD_PROFILE);
    const survivors = result.ranked.filter(
      (s) => s.candidate.evidence.beatmatched && !s.vetoed,
    );
    expect(survivors.length).toBeGreaterThan(0);
  });

  it("CONSERVATIVE still refuses the loose real band — temperaments stay distinct", () => {
    const recipe = authorRecipe({
      ...pairAt(0.17),
      profile: CONSERVATIVE_PROFILE,
    });
    expect(recipe).not.toBeNull();
    expect(recipe!.overlap.beatmatched).toBe(false);
  });
});

describe("note27 C2 — a true guess still earns no beatmatch", () => {
  it("a pair in the measured guess band (0.03) authors no beatmatched join", () => {
    const recipe = authorRecipe(pairAt(0.03));
    expect(recipe).not.toBeNull();
    expect(recipe!.overlap.beatmatched).toBe(false);
    const candidates = candidatesForPair(pairAt(0.03));
    expect(candidates.every((c) => !c.evidence.beatmatched)).toBe(true);
  });

  it("a long blend carrying guess-band evidence is vetoed by scoring, in its own words", () => {
    const candidates = candidatesForPair(pairAt(0.17));
    const blend = candidates.find((c) => c.family === "standard-blend")!;
    expect(blend).toBeDefined();
    const guessed: Candidate = {
      ...blend,
      evidence: { ...blend.evidence, tempoConfidence: 0.03 },
    };
    const scored = scoreCandidates([guessed], {}, STANDARD_PROFILE).ranked[0];
    expect(scored.vetoed).toBe(true);
    expect(scored.vetoReasons.join(" ")).toContain("beatmatch on a guess");
  });
});
