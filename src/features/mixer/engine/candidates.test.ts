import { describe, expect, it } from "vitest";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import { candidatesForPair } from "./candidates";
import { STANDARD_PROFILE } from "./decisionProfile";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { validateRecipe } from "./recipe";
import type { RecipeRequest } from "./transitionPlanner";

// Candidates (S5-3): the set a pair produces, exercised against the
// blueprint §5 acceptance tests — one per charter requirement from
// the Note 4/11 diagnosis. Fixture arithmetic: 120 BPM, so a beat is
// 0.5 s and a 240 s track is 480 beats.

function key(
  camelot: string,
  pitchClass: number,
  mode: "major" | "minor" = "major",
): KeyEstimate {
  return { tonic: "C", mode, pitchClass, camelot, confidence: 0.9 };
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
    analysisVersion: 2,
    audioHash: "hash-a",
    ...overrides,
  };
}

/**
 * A vocal pair with a normal ending: A sings until its outro, B
 * sings from its intro's end and offers a strong drop; both carry
 * full section structure. Position: 60 s in (beat 120).
 */
function richRequest(): RecipeRequest {
  const outgoing = analysis({
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

const BLEND_FAMILIES = new Set([
  "long-blend",
  "standard-blend",
  "short-blend",
  "loop-extended-blend",
]);

describe("candidates — charter requirement 3: measurements have teeth", () => {
  it("Req 3 — a 20%-stretch pair yields NO beatmatched candidate", () => {
    const request = richRequest();
    request.incoming = analysis({
      ...request.incoming,
      beatMap: {
        bpm: 120 / 1.2,
        firstBeatSec: 0,
        beatsPerBar: 4,
        durationSec: 240,
      },
    });
    const candidates = candidatesForPair(request);
    expect(candidates.length).toBeGreaterThan(0);
    // Beyond every shipped reach — the widest rate cap AND the
    // widest rendition ceiling (+15%) alike: the pair changes
    // family instead of stretching.
    expect(candidates.every((c) => !c.evidence.beatmatched)).toBe(true);
    expect(candidates.every((c) => c.recipe.overlap.rateB === 1)).toBe(true);
    expect(candidates.every((c) => c.recipe.overlap.stretchB === null)).toBe(
      true,
    );
  });

  it("Req 3 — a 15%-stretch pair beatmatches ONLY as an adventurous rendition", () => {
    const request = richRequest();
    request.incoming = analysis({
      ...request.incoming,
      beatMap: {
        bpm: 120 / 1.15,
        firstBeatSec: 0,
        beatsPerBar: 4,
        durationSec: 240,
      },
    });
    const candidates = candidatesForPair(request);
    const beatmatched = candidates.filter((c) => c.evidence.beatmatched);
    // The widest ceiling in the building is adventurous's +15% —
    // exactly this pair. Only its telling beatmatches, and it does
    // so as a rendition: stretchB set, evidence flagged, and a flat
    // rate curve (no hold, no return glide — the rendition IS at
    // tempo).
    expect(beatmatched.length).toBeGreaterThan(0);
    for (const candidate of beatmatched) {
      expect(candidate.profileId).toBe("adventurous");
      expect(candidate.evidence.stretchMode).toBe(true);
      expect(candidate.recipe.overlap.stretchB).toBeCloseTo(1.15, 6);
      expect(candidate.recipe.automation.rateB.points).toEqual([
        { atMs: 0, value: 1 },
      ]);
      expect(validateRecipe(candidate.recipe)).toEqual([]);
    }
  });

  it("Req 3 — a low-tempo-confidence pair yields NO beatmatched candidate", () => {
    const request = richRequest();
    request.incoming = analysis({
      ...request.incoming,
      // 0.03 is the measured guess band on the repaired
      // (mean-centred) confidence scale — note27-c2-fix.md's
      // prescribed remedy; 0.1 on that scale is weak-but-real
      // evidence the adventurous floor (0.05) legitimately admits.
      tempoConfidence: 0.03,
    });
    const candidates = candidatesForPair(request);
    expect(candidates.length).toBeGreaterThan(0);
    // Don't beatmatch on a guess — under any profile.
    expect(candidates.every((c) => !c.evidence.beatmatched)).toBe(true);
  });

  it("Req 3 — a distant-key pair yields no long blend", () => {
    const request = richRequest();
    request.incoming = analysis({
      ...request.incoming,
      key: key("3B", 5),
    });
    const candidates = candidatesForPair(request);
    const blends = candidates.filter((c) => BLEND_FAMILIES.has(c.family));
    expect(blends.length).toBeGreaterThan(0);
    for (const blend of blends) {
      expect(blend.evidence.blendBeats).toBeLessThanOrEqual(8 + 1e-9);
      expect(blend.evidence.keyRelation).toBe("distant");
    }
  });

  it("Req 3 — drop-entry choice follows strength, not earliness", () => {
    const request = richRequest();
    request.incoming = analysis({
      ...request.incoming,
      // Strongest first, per the analysis contract: the strong drop
      // is LATER than the weak one. v1 entered at the earliest.
      drops: [
        { timeSec: 24, beat: 48, strength: 2.6 },
        { timeSec: 8, beat: 16, strength: 1.2 },
      ],
    });
    const candidates = candidatesForPair(request);
    const dropEntries = candidates.filter(
      (c) => c.evidence.entryKind === "drop",
    );
    expect(dropEntries.length).toBeGreaterThan(0);
    expect(dropEntries.every((c) => c.evidence.entryDropStrength === 2.6)).toBe(
      true,
    );
  });
});

describe("candidates — charter requirement 6: more than four leaves", () => {
  it("Req 6 — a vocal pair with a normal ending yields at least three feasible families", () => {
    const candidates = candidatesForPair(richRequest());
    const families = new Set(candidates.map((c) => c.family));
    expect(families.size).toBeGreaterThanOrEqual(3);
    // The spread the charter asks for: a blend, a cut family, a fade
    // family, and the restraint families are all honestly available.
    expect([...families].some((f) => BLEND_FAMILIES.has(f))).toBe(true);
    expect(families.has("drop-cut")).toBe(true);
    expect(families.has("let-it-play")).toBe(true);
    expect(families.has("early-cut")).toBe(true);
    // …and every one of them is performable as written.
    for (const candidate of candidates) {
      expect(validateRecipe(candidate.recipe)).toEqual([]);
    }
  });

  it("Req 6 — let-it-play is a producible candidate", () => {
    const candidates = candidatesForPair(richRequest());
    const letItPlay = candidates.find((c) => c.family === "let-it-play");
    expect(letItPlay).toBeDefined();
    // A plays to its very end (240 s); the overlap is a clean start.
    expect(letItPlay!.recipe.overlap.startAMs).toBe(240_000);
    expect(letItPlay!.recipe.overlap.durationMs).toBe(0);
    expect(letItPlay!.evidence.exitKind).toBe("track-end");
  });

  it("Req 6 — early-cut is a producible candidate", () => {
    const candidates = candidatesForPair(richRequest());
    const earlyCut = candidates.find((c) => c.family === "early-cut");
    expect(earlyCut).toBeDefined();
    // It leaves before the outro (200 s) — the remainder is unplayed.
    expect(earlyCut!.recipe.overlap.startAMs).toBeLessThan(200_000);
    expect(earlyCut!.recipe.overlap.durationMs).toBe(0);
  });
});

describe("candidates — the set itself", () => {
  it("identical plans from two profiles collapse to one candidate", () => {
    const once = candidatesForPair(richRequest(), {
      profiles: [STANDARD_PROFILE],
    });
    const twice = candidatesForPair(richRequest(), {
      profiles: [STANDARD_PROFILE, STANDARD_PROFILE],
    });
    expect(twice.length).toBe(once.length);
  });

  it("candidates carry the pair-shape in joinHistory's vocabulary", () => {
    const candidates = candidatesForPair(richRequest());
    for (const candidate of candidates) {
      expect(candidate.evidence.pairShape).toBe("matched/same/both-vocal");
    }
  });
});
