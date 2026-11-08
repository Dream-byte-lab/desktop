// canMix.test.ts — the One Ruler's pins (wave item 1).
//
// The predicate's contract: three proof outcomes, unknown fails
// closed at every tier, DJ-path unresolvability refuses at every
// tier, and the authors' old private feasibility formula is the
// same definition as canMix's beatmatch sub-proof.

import { describe, expect, it } from "vitest";
import {
  beatmatchProven,
  canMix,
  entryBoundaryMs,
  exitBoundaryMs,
  MIX_TIERS,
} from "./canMix";
import { buildTrackFacts, type TrackFacts, type TrackRead } from "./facts";

const KEY_C = {
  tonic: 0,
  mode: "major" as const,
  camelot: "8B",
  confidence: 0.9,
};
const KEY_G = {
  tonic: 7,
  mode: "major" as const,
  camelot: "9B",
  confidence: 0.9,
};
const KEY_FSHARP = {
  tonic: 6,
  mode: "major" as const,
  camelot: "2B",
  confidence: 0.9,
};

function makeRead(overrides: Partial<TrackRead> = {}): TrackRead {
  const beatsMs: number[] = [];
  for (let b = 0; b <= 480; b += 1) beatsMs.push(b * 500);
  const downbeatsMs: number[] = [];
  for (let b = 0; b <= 480; b += 4) downbeatsMs.push(b * 500);
  return {
    audioHash: "hash",
    analysisVersion: 1,
    depth: "deep",
    durationSec: 240,
    bpm: 120,
    tempoConfidence: 0.9,
    grid: { beatsMs, downbeatsMs, beatsPerBar: 4, confidence: 0.9 },
    key: KEY_C,
    sections: [
      { kind: "intro", startMs: 0, endMs: 30_000, meanEnergy: 0.08 },
      { kind: "verse", startMs: 30_000, endMs: 120_000, meanEnergy: 0.2 },
      { kind: "chorus", startMs: 120_000, endMs: 225_000, meanEnergy: 0.3 },
      { kind: "outro", startMs: 225_000, endMs: 240_000, meanEnergy: 0.1 },
    ],
    energyCurvePerSec: [],
    energyContour: [],
    vocalActivity: [
      { startMs: 0, endMs: 240_000, activity: 0.1, confidence: 0.9 },
    ],
    drops: [],
    loudnessRms: 0.2,
    ...overrides,
  };
}

function facts(id: string, overrides: Partial<TrackRead> = {}): TrackFacts {
  return buildTrackFacts(id, makeRead(overrides), 240_000);
}

const RESOLVED = { resolvableA: "resolved", resolvableB: "resolved" } as const;

describe("canMix — the tidy pair proves at every tier", () => {
  const a = facts("a");
  const b = facts("b", { key: KEY_G, bpm: 122 });

  for (const tier of MIX_TIERS) {
    it(`proves at ${tier}`, () => {
      const result = canMix(a, b, { tier, ...RESOLVED });
      expect(result.proof).toBe("proven");
      expect(result.reasons).toEqual([]);
    });
  }

  it("reports honest margins", () => {
    const result = canMix(a, b, { tier: "phrase-blend", ...RESOLVED });
    expect(result.margins.tempoRatio).toBeCloseTo(120 / 122, 3);
    expect(result.margins.keyRelation).not.toBeNull();
    expect(result.margins.vocalWitnessed).toBe(true);
    expect(result.margins.vocalOverlap).toBeLessThan(0.5);
    expect(result.margins.exitPhraseAtMs).not.toBeNull();
    expect(result.margins.entryPhraseAtMs).not.toBeNull();
  });
});

describe("canMix — the DJ-path gate", () => {
  const a = facts("a");
  const b = facts("b");

  it("an unresolvable incoming track refuses at EVERY tier", () => {
    for (const tier of MIX_TIERS) {
      const result = canMix(a, b, {
        tier,
        resolvableA: "resolved",
        resolvableB: "unresolvable",
      });
      expect(result.proof).toBe("refused");
      expect(result.reasons.join(" ")).toContain("DJ path");
    }
  });

  it("unknown resolvability fails closed at every tier", () => {
    for (const tier of MIX_TIERS) {
      const result = canMix(a, b, { tier });
      expect(result.proof).toBe("unproven");
    }
  });
});

describe("canMix — low-confidence facts fail closed per tier", () => {
  const a = facts("a");
  const untrusted = facts("u", {
    tempoConfidence: 0.05,
    grid: {
      beatsMs: Array.from({ length: 481 }, (_, b) => b * 500),
      downbeatsMs: Array.from({ length: 121 }, (_, b) => b * 2000),
      beatsPerBar: 4,
      confidence: 0.05,
    },
  });

  it("untrusted grids: blend tiers unproven, cut and crossfade still prove", () => {
    expect(
      canMix(a, untrusted, { tier: "phrase-blend", ...RESOLVED }).proof,
    ).toBe("unproven");
    expect(canMix(a, untrusted, { tier: "beatmatch", ...RESOLVED }).proof).toBe(
      "unproven",
    );
    expect(
      canMix(a, untrusted, { tier: "phrase-cut", ...RESOLVED }).proof,
    ).toBe("proven");
    expect(canMix(a, untrusted, { tier: "crossfade", ...RESOLVED }).proof).toBe(
      "proven",
    );
  });

  it("an unknown key fails the phrase-blend tier only", () => {
    const keyless = facts("k", { key: null });
    expect(
      canMix(a, keyless, { tier: "phrase-blend", ...RESOLVED }).proof,
    ).toBe("unproven");
    expect(canMix(a, keyless, { tier: "beatmatch", ...RESOLVED }).proof).toBe(
      "proven",
    );
  });

  it("unwitnessed vocals fail the phrase-blend tier only", () => {
    const silent = facts("s", { vocalActivity: [] });
    const result = canMix(a, silent, { tier: "phrase-blend", ...RESOLVED });
    expect(result.proof).toBe("unproven");
    expect(result.margins.vocalWitnessed).toBe(false);
    expect(canMix(a, silent, { tier: "beatmatch", ...RESOLVED }).proof).toBe(
      "proven",
    );
  });
});

describe("canMix — positive failures refuse the blend tiers", () => {
  const a = facts("a");

  it("tempos outside the feasible rate window refuse beatmatch", () => {
    const slow = facts("slow", { bpm: 90 });
    expect(canMix(a, slow, { tier: "beatmatch", ...RESOLVED }).proof).toBe(
      "refused",
    );
    expect(canMix(a, slow, { tier: "phrase-cut", ...RESOLVED }).proof).toBe(
      "proven",
    );
  });

  it("witnessed vocals loud on both sides refuse the phrase blend", () => {
    const loud = {
      vocalActivity: [
        { startMs: 0, endMs: 240_000, activity: 0.85, confidence: 0.9 },
      ],
    };
    const va = facts("va", loud);
    const vb = facts("vb", loud);
    const result = canMix(va, vb, { tier: "phrase-blend", ...RESOLVED });
    expect(result.proof).toBe("refused");
    expect(result.margins.vocalOverlap).toBeGreaterThanOrEqual(0.5);
    // The refusal is window-scoped: the pair can still beatmatch/cut.
    expect(canMix(va, vb, { tier: "beatmatch", ...RESOLVED }).proof).toBe(
      "proven",
    );
  });

  it("distant keys prove only across the short cap window", () => {
    const distant = facts("d", { key: KEY_FSHARP });
    expect(
      canMix(a, distant, { tier: "phrase-blend", ...RESOLVED }).proof,
    ).toBe("unproven");
    expect(
      canMix(a, distant, {
        tier: "phrase-blend",
        ...RESOLVED,
        windowBeats: 8,
      }).proof,
    ).toBe("proven");
  });
});

describe("beatmatchProven — the authors' delegated gate", () => {
  it("is exactly trusted-grids + feasible-ratio", () => {
    const a = facts("a");
    expect(beatmatchProven(a, facts("b", { bpm: 122 })).proven).toBe(true);
    expect(beatmatchProven(a, facts("b", { bpm: 90 })).proven).toBe(false);
    expect(
      beatmatchProven(a, facts("b", { tempoConfidence: 0.05 })).proven,
    ).toBe(false);
    expect(beatmatchProven(a, facts("b", { bpm: 122 })).ratio).toBeCloseTo(
      120 / 122,
      5,
    );
  });
});

describe("phrase geography helpers", () => {
  it("exit boundary sits at or after the play floor; entry is the first phrase", () => {
    const a = facts("a");
    const exit = exitBoundaryMs(a);
    const entry = entryBoundaryMs(a);
    expect(entry).toBe(0);
    expect(exit).not.toBeNull();
    expect(exit!).toBeGreaterThanOrEqual((a.minimumPlayMs ?? 0) - 1);
  });

  it("a read with no grid has no boundaries", () => {
    const bare = buildTrackFacts("bare", null, 240_000);
    expect(exitBoundaryMs(bare)).toBeNull();
    expect(entryBoundaryMs(bare)).toBeNull();
    expect(canMix(bare, bare, { tier: "phrase-cut", ...RESOLVED }).proof).toBe(
      "unproven",
    );
  });
});
