import { describe, expect, it } from "vitest";
import { buildTrackFacts } from "./facts";
import {
  validateRecipe,
  valueAt,
  type CurvePoint,
  type JoinRecipe,
} from "./recipe";

const factsA = buildTrackFacts("a", null, 240_000);
const factsB = buildTrackFacts("b", null, 200_000);

function wellFormed(): JoinRecipe {
  return {
    id: "join-1",
    family: "blend",
    outgoing: {
      trackId: "a",
      audioHash: "hash-a",
      exitAnchorMs: 180_000,
      exitBeat: 360,
    },
    incoming: {
      trackId: "b",
      audioHash: "hash-b",
      entryAnchorMs: 8_000,
      entryBeat: 16,
    },
    overlapBeats: 32,
    rates: { rateA: 1, rateB: 1.0, beatmatched: true },
    curves: {
      gainA: [
        { atBeat: 0, value: 1 },
        { atBeat: 32, value: 0 },
      ],
      gainB: [
        { atBeat: 0, value: 0 },
        { atBeat: 32, value: 1 },
      ],
      eqA: {
        low: [
          { atBeat: 0, value: 1 },
          { atBeat: 16, value: 0.2 },
        ],
        mid: [{ atBeat: 0, value: 1 }],
        high: [{ atBeat: 0, value: 1 }],
      },
      eqB: {
        low: [
          { atBeat: 0, value: 0.2 },
          { atBeat: 16, value: 1 },
        ],
        mid: [{ atBeat: 0, value: 1 }],
        high: [{ atBeat: 0, value: 1 }],
      },
      filterA: [{ atBeat: 0, value: 20_000 }],
      filterB: [{ atBeat: 0, value: 20_000 }],
    },
    blocks: [
      { type: "loop", side: "B", startMs: 8_000, endMs: 16_000, wraps: 2 },
      {
        type: "jog",
        side: "A",
        kind: "nudge",
        atBeat: 8,
        beats: 2,
        bend: 0.98,
      },
      {
        type: "scratch",
        side: "B",
        technique: "chirp",
        atBeat: 0,
        beats: 4,
        windowStartMs: 8_000,
        windowEndMs: 10_000,
      },
      {
        type: "fx",
        side: "tail",
        kind: "reverb",
        atBeat: 28,
        beats: 4,
        params: { wet: 0.6, decay: 1.8 },
      },
    ],
    authored: {
      evidence: { tempoFit: 0.9, keyFit: 0.85 },
      notes: ["phrase-aligned blend"],
    },
  };
}

describe("validateRecipe — structural only", () => {
  it("accepts a well-formed recipe", () => {
    expect(validateRecipe(wellFormed(), factsA, factsB)).toEqual([]);
  });

  it("accepts a musically wild but structurally sound recipe", () => {
    // One-beat overlap, absurd curve values, extreme-but-finite fx:
    // taste is the authors' business, never the validator's.
    const recipe = wellFormed();
    recipe.overlapBeats = 1;
    recipe.curves.gainA = [{ atBeat: 0, value: 4.5 }];
    recipe.blocks = [
      {
        type: "fx",
        side: "A",
        kind: "saturation",
        atBeat: 0,
        beats: 1,
        params: { drive: 40 },
      },
    ];
    expect(validateRecipe(recipe, factsA, factsB)).toEqual([]);
  });

  it("does not bound anchors when a duration is unknown", () => {
    const unknownA = buildTrackFacts("a", null, null);
    const recipe = wellFormed();
    recipe.outgoing.exitAnchorMs = 999_999_999;
    expect(validateRecipe(recipe, unknownA, factsB)).toEqual([]);
  });

  it("rejects rates outside [0.5, 2]", () => {
    const recipe = wellFormed();
    recipe.rates.rateA = 2.5;
    const errors = validateRecipe(recipe, factsA, factsB);
    expect(errors.some((e) => e.includes("rates.rateA"))).toBe(true);
  });

  it("rejects an anchor past the track's known duration", () => {
    const recipe = wellFormed();
    recipe.outgoing.exitAnchorMs = 300_000; // track A is 240 s
    const errors = validateRecipe(recipe, factsA, factsB);
    expect(errors.some((e) => e.includes("exitAnchorMs"))).toBe(true);
  });

  it("rejects unordered curve points and non-finite values", () => {
    const recipe = wellFormed();
    recipe.curves.gainB = [
      { atBeat: 16, value: 0.5 },
      { atBeat: 8, value: 1 },
    ];
    recipe.curves.filterA = [{ atBeat: 0, value: Number.NaN }];
    const errors = validateRecipe(recipe, factsA, factsB);
    expect(errors.some((e) => e.includes("gainB"))).toBe(true);
    expect(errors.some((e) => e.includes("filterA"))).toBe(true);
  });

  it("rejects blocks whose spans are broken or outside their track", () => {
    const recipe = wellFormed();
    recipe.blocks = [
      { type: "loop", side: "A", startMs: 16_000, endMs: 8_000, wraps: 2 },
      {
        type: "scratch",
        side: "B",
        technique: "crab",
        atBeat: 0,
        beats: 4,
        windowStartMs: 190_000,
        windowEndMs: 250_000, // track B is 200 s
      },
      {
        type: "fx",
        side: "tail",
        kind: "delay",
        atBeat: 0,
        beats: 0,
        params: { wet: 0.5 },
      },
    ];
    const errors = validateRecipe(recipe, factsA, factsB);
    expect(errors.some((e) => e.includes("loop span"))).toBe(true);
    expect(errors.some((e) => e.includes("past the track"))).toBe(true);
    expect(errors.some((e) => e.includes("fx beats"))).toBe(true);
  });

  it("rejects unknown families, techniques and non-finite evidence", () => {
    const recipe = wellFormed();
    (recipe as { family: string }).family = "let-it-play";
    recipe.authored.evidence = { tempoFit: Number.POSITIVE_INFINITY };
    const errors = validateRecipe(recipe, factsA, factsB);
    expect(errors.some((e) => e.includes("family"))).toBe(true);
    expect(errors.some((e) => e.includes("authored.evidence"))).toBe(true);
  });
});

describe("valueAt — curve evaluation", () => {
  const ramp: CurvePoint[] = [
    { atBeat: 0, value: 0 },
    { atBeat: 10, value: 1 },
    { atBeat: 20, value: 1 },
  ];

  it("interpolates linearly and clamps outside the point range", () => {
    expect(valueAt(ramp, -5)).toBe(0);
    expect(valueAt(ramp, 0)).toBe(0);
    expect(valueAt(ramp, 5)).toBeCloseTo(0.5);
    expect(valueAt(ramp, 10)).toBe(1);
    expect(valueAt(ramp, 99)).toBe(1);
  });

  it("holds the starting value across a step segment", () => {
    const stepped: CurvePoint[] = [
      { atBeat: 0, value: 0.25, easing: "step" },
      { atBeat: 8, value: 0.75 },
      { atBeat: 16, value: 1 },
    ];
    expect(valueAt(stepped, 4)).toBe(0.25);
    expect(valueAt(stepped, 8)).toBe(0.75);
    expect(valueAt(stepped, 12)).toBeCloseTo(0.875);
  });

  it("an empty curve evaluates to 0", () => {
    expect(valueAt([], 4)).toBe(0);
  });
});
