import { describe, expect, it } from "vitest";
import {
  authorCandidates,
  fxKindsOfRecipe,
  isFxDressed,
  type AuthorResult,
} from "./authors";
import {
  FX_KINDS,
  SCRATCH_TECHNIQUES,
  validateRecipe,
  valueAt,
  type JoinRecipe,
} from "./recipe";
import { NEUTRAL_SHAPING, NEUTRAL_SLIDERS, resolveShaping } from "./shaping";
import {
  FIXTURE_PAIRS,
  clubA,
  clubB,
  distantA,
  distantB,
  dropA,
  dropB,
  folkA,
  folkB,
  popA,
  popB,
} from "./testFixtures";

const EVIDENCE_KEYS = [
  "energyFit",
  "keyFit",
  "phraseFit",
  "structureFit",
  "tempoFit",
  "vocalSafety",
];

function author(a = clubA, b = clubB, shaping = NEUTRAL_SHAPING): AuthorResult {
  return authorCandidates(a, b, { arcPosition: 0.5, shaping });
}

function allFixtureResults(): {
  name: string;
  a: typeof clubA;
  b: typeof clubB;
  result: AuthorResult;
}[] {
  return FIXTURE_PAIRS.map((pair) => ({
    name: pair.name,
    a: pair.a,
    b: pair.b,
    result: author(pair.a, pair.b),
  }));
}

function jogKinds(recipe: JoinRecipe): string[] {
  return recipe.blocks
    .filter((block) => block.type === "jog")
    .map((block) => (block.type === "jog" ? block.kind : ""));
}

describe("authors — every generated candidate validates and carries full evidence", () => {
  it("validateRecipe returns [] for every candidate in every fixture", () => {
    for (const { name, a, b, result } of allFixtureResults()) {
      expect(result.candidates.length, name).toBeGreaterThan(0);
      for (const candidate of result.candidates) {
        expect(
          validateRecipe(candidate, a, b),
          `${name}: ${candidate.id}`,
        ).toEqual([]);
      }
    }
    // Reversed pairs exercise the same authors from the other side.
    const reversed = author(clubB, clubA);
    for (const candidate of reversed.candidates) {
      expect(validateRecipe(candidate, clubB, clubA)).toEqual([]);
    }
  });

  it("every candidate's evidence is exactly the six raw components, all in [0, 1]", () => {
    for (const { result } of allFixtureResults()) {
      for (const candidate of result.candidates) {
        expect(Object.keys(candidate.authored.evidence).sort()).toEqual(
          EVIDENCE_KEYS,
        );
        for (const value of Object.values(candidate.authored.evidence)) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("beat space: nothing starts before beat 0 (ruling floor is -8)", () => {
    for (const { result } of allFixtureResults()) {
      for (const candidate of result.candidates) {
        const curves = [
          candidate.curves.gainA,
          candidate.curves.gainB,
          candidate.curves.eqA.low,
          candidate.curves.eqB.low,
          candidate.curves.filterA,
          candidate.curves.filterB,
        ];
        for (const curve of curves) {
          expect(curve.length).toBeGreaterThan(0);
          for (const point of curve) {
            expect(point.atBeat).toBeGreaterThanOrEqual(0);
          }
        }
        for (const block of candidate.blocks) {
          if (block.type !== "loop")
            expect(block.atBeat).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

describe("authors — blends", () => {
  it("club pair: short / standard / long at 8 / 16 / 28 beats under neutral shaping", () => {
    const blends = author().candidates.filter(
      (c) => c.family === "blend" && !isFxDressed(c),
    );
    expect(blends.map((c) => c.overlapBeats).sort((x, y) => x - y)).toEqual([
      8, 16, 28,
    ]);
    for (const blend of blends) {
      expect(blend.rates).toEqual({
        rateA: 1,
        rateB: 124 / 126,
        beatmatched: true,
      });
    }
  });

  it("the bass swap crosses at the bar nearest the middle", () => {
    const standard = author().candidates.find(
      (c) => c.family === "blend" && c.overlapBeats === 16 && !isFxDressed(c),
    );
    expect(standard).toBeDefined();
    if (!standard) return;
    // At the swap beat (8) the two low EQs pass through the same value.
    expect(valueAt(standard.curves.eqA.low, 8)).toBeCloseTo(
      valueAt(standard.curves.eqB.low, 8),
      1,
    );
    expect(valueAt(standard.curves.eqA.low, 0)).toBe(1);
    expect(valueAt(standard.curves.eqB.low, 16)).toBe(1);
  });

  it("the blend centre bend moves the geometry (house centre 32 → standard 32)", () => {
    const house = resolveShaping("house", NEUTRAL_SLIDERS);
    const blends = author(clubA, clubB, house).candidates.filter(
      (c) => c.family === "blend" && !isFxDressed(c),
    );
    expect(Math.max(...blends.map((c) => c.overlapBeats))).toBe(32);
    expect(blends.some((c) => c.overlapBeats === 32)).toBe(true);
  });

  it("vocal pop blends are priced by their vocal evidence, not vetoed", () => {
    const popBlends = author(popA, popB).candidates.filter(
      (c) => c.family === "blend",
    );
    const clubBlends = author().candidates.filter((c) => c.family === "blend");
    expect(popBlends.length).toBeGreaterThan(0);
    const popSafety = Math.max(
      ...popBlends.map((c) => c.authored.evidence.vocalSafety),
    );
    const clubSafety = Math.max(
      ...clubBlends.map((c) => c.authored.evidence.vocalSafety),
    );
    expect(popSafety).toBeLessThan(clubSafety);
  });
});

describe("authors — loop-blend, drop-cut, stop exits", () => {
  it("loop-blend stretches the drop pair's short outro with a loop block", () => {
    const loopBlend = author(dropA, dropB).candidates.find(
      (c) => c.family === "loop-blend",
    );
    expect(loopBlend).toBeDefined();
    const loop = loopBlend?.blocks.find((b) => b.type === "loop");
    expect(loop?.type).toBe("loop");
    if (loop?.type === "loop") {
      expect(loop.wraps).toBeGreaterThanOrEqual(1);
      expect(loop.endMs).toBeLessThanOrEqual(dropA.durationMs ?? Infinity);
    }
    // The tidy club outro already fits: loop-blend is rejected there.
    const clubRejected = author().rejected.filter(
      (r) => r.family === "loop-blend",
    );
    expect(clubRejected).toHaveLength(1);
  });

  it("drop-cut lands the incoming drop on an outgoing phrase end", () => {
    const cut = author(dropA, dropB).candidates.find(
      (c) => c.family === "drop-cut",
    );
    expect(cut).toBeDefined();
    if (!cut) return;
    const entryBeat = dropB.beatAtMs(cut.incoming.entryAnchorMs) ?? -1;
    // The drop (beat 16 of drop-b) lands 4 beats into the overlap.
    expect(entryBeat + 4).toBeCloseTo(16);
    const exitBeat = dropA.beatAtMs(cut.outgoing.exitAnchorMs) ?? -1;
    // …and at that same overlap beat the outgoing side reaches a
    // phrase end: beat 496, the first beat of its outro.
    expect(exitBeat + 4).toBe(496);
    expect((exitBeat + 4) % 16).toBe(0);
  });

  it("stop exits: brake + spinback on long tails, vinyl-stop on short tails", () => {
    const clubKinds = author()
      .candidates.filter((c) => c.family === "stop-exit")
      .flatMap(jogKinds);
    expect(clubKinds).toContain("brake");
    expect(clubKinds).toContain("spinback");
    expect(clubKinds).not.toContain("vinyl-stop");
    const dropKinds = author(dropA, dropB)
      .candidates.filter((c) => c.family === "stop-exit")
      .flatMap(jogKinds);
    expect(dropKinds).toContain("vinyl-stop");
    expect(dropKinds).toContain("spinback");
    expect(dropKinds).not.toContain("brake");
  });
});

describe("authors — scratches and nudges (contract techniques)", () => {
  it("every scratch technique is generated at least once across fixtures", () => {
    const seen = new Set<string>();
    for (const { result } of allFixtureResults()) {
      for (const candidate of result.candidates) {
        if (candidate.technique) seen.add(candidate.technique);
        for (const block of candidate.blocks) {
          if (block.type === "scratch") seen.add(block.technique);
        }
      }
    }
    for (const technique of SCRATCH_TECHNIQUES) {
      expect(seen.has(technique), technique).toBe(true);
    }
  });

  it("club pair authors all five techniques on both scratch families", () => {
    const { candidates } = author();
    for (const family of ["scratch-in", "scratch-out"] as const) {
      const techniques = new Set(
        candidates.filter((c) => c.family === family).map((c) => c.technique),
      );
      for (const technique of SCRATCH_TECHNIQUES) {
        expect(techniques.has(technique), `${family}/${technique}`).toBe(true);
      }
    }
  });

  it("vocal pop authors NO scratches (vocal / flat windows), with reasons", () => {
    const { candidates, rejected } = author(popA, popB);
    expect(candidates.some((c) => c.family.startsWith("scratch"))).toBe(false);
    expect(rejected.some((r) => r.family === "scratch-in")).toBe(true);
    expect(rejected.some((r) => r.family === "scratch-out")).toBe(true);
  });

  it("nudge jogs ride the long blend and stand alone on stop/scratch joins", () => {
    const { candidates } = author();
    const longBlend = candidates.find(
      (c) => c.family === "blend" && c.overlapBeats === 28,
    );
    expect(longBlend && jogKinds(longBlend)).toContain("nudge");
    const nudgeJog = longBlend?.blocks.find(
      (b) => b.type === "jog" && b.kind === "nudge",
    );
    if (nudgeJog?.type === "jog") {
      expect(nudgeJog.bend).toBeCloseTo(124 / 126);
      expect(nudgeJog.bend).not.toBe(1);
      expect(nudgeJog.bend ?? 0).toBeGreaterThanOrEqual(0.92);
      expect(nudgeJog.bend ?? 2).toBeLessThanOrEqual(1.08);
    } else {
      throw new Error("long blend carries no nudge jog");
    }
    expect(
      candidates.some(
        (c) => c.family === "stop-exit" && jogKinds(c).includes("nudge"),
      ),
    ).toBe(true);
    expect(
      candidates.some(
        (c) => c.family === "scratch-in" && jogKinds(c).includes("nudge"),
      ),
    ).toBe(true);
  });
});

describe("authors — fx dressings", () => {
  it("every fx kind is dressed at least once across fixtures", () => {
    const seen = new Set<string>();
    for (const { result } of allFixtureResults()) {
      for (const candidate of result.candidates) {
        for (const kind of fxKindsOfRecipe(candidate)) seen.add(kind);
      }
    }
    for (const kind of FX_KINDS) {
      expect(seen.has(kind), kind).toBe(true);
    }
  });

  it("dressings keep the host family and evidence, and name themselves in notes", () => {
    const { candidates } = author();
    const base = candidates.find(
      (c) => c.family === "blend" && c.overlapBeats === 16 && !isFxDressed(c),
    );
    const dressed = candidates.filter(
      (c) => c.family === "blend" && c.overlapBeats === 16 && isFxDressed(c),
    );
    expect(dressed.length).toBeGreaterThanOrEqual(4);
    for (const candidate of dressed) {
      expect(candidate.authored.evidence).toEqual(base?.authored.evidence);
      expect(
        candidate.authored.notes.some((n) => n.startsWith("fx-dressing:")),
      ).toBe(true);
    }
    // The delay->reverb TAIL chain is ONE candidate with TWO tail blocks.
    const chain = dressed.find((c) =>
      c.authored.notes.some((n) => n.includes("delay into reverb")),
    );
    expect(chain).toBeDefined();
    const tailFx = chain?.blocks.filter(
      (b) => b.type === "fx" && b.side === "tail",
    );
    expect(tailFx?.map((b) => (b.type === "fx" ? b.kind : ""))).toEqual([
      "delay",
      "reverb",
    ]);
  });

  it("CHOP reads the material: slip-roll on transient-rich, gating on flat", () => {
    const clubKinds = new Set(
      author().candidates.flatMap((c) => fxKindsOfRecipe(c)),
    );
    expect(clubKinds.has("slip-roll")).toBe(true);
    expect(clubKinds.has("gating")).toBe(false);
    const popKinds = new Set(
      author(popA, popB).candidates.flatMap((c) => fxKindsOfRecipe(c)),
    );
    expect(popKinds.has("gating")).toBe(true);
    expect(popKinds.has("slip-roll")).toBe(false);
  });

  it("GRIT saturation lands on the drop pair's witnessed-quiet drop", () => {
    const dropKinds = new Set(
      author(dropA, dropB).candidates.flatMap((c) => fxKindsOfRecipe(c)),
    );
    expect(dropKinds.has("saturation")).toBe(true);
    const clubKinds = new Set(
      author().candidates.flatMap((c) => fxKindsOfRecipe(c)),
    );
    expect(clubKinds.has("saturation")).toBe(false);
  });
});

describe("authors — performer contract (Wave 2B ruling)", () => {
  const FX_PARAM_KEYS_BY_KIND: Record<string, string[]> = {
    reverb: ["wet", "decay"],
    delay: ["wet", "timeSec", "beats", "feedback"],
    spiral: ["wet", "timeSec", "beats", "feedbackMax", "freqStart", "freqEnd"],
    flanger: ["wet", "rate", "depth"],
    phaser: ["wet", "rate", "depth"],
    saturation: ["wet", "drive"],
    gating: ["wet", "division", "depth", "low"],
    "slip-roll": ["wet", "sliceBeats"],
  };
  const FX_PARAM_VOCABULARY = [
    "wet",
    "decay",
    "timeSec",
    "beats",
    "feedback",
    "feedbackMax",
    "freqStart",
    "freqEnd",
    "drive",
    "rate",
    "depth",
    "division",
    "low",
    "sliceBeats",
  ];

  it("curve units: gain/EQ are linear multipliers, filters are Hz in [30, 20000]", () => {
    for (const { result } of allFixtureResults()) {
      for (const candidate of result.candidates) {
        for (const curve of [candidate.curves.gainA, candidate.curves.gainB]) {
          for (const point of curve) {
            expect(point.value).toBeGreaterThanOrEqual(0);
            expect(point.value).toBeLessThanOrEqual(1);
          }
        }
        for (const eq of [candidate.curves.eqA, candidate.curves.eqB]) {
          for (const band of [eq.low, eq.mid, eq.high]) {
            for (const point of band) {
              // Linear multiplier mapped to dB by the performer:
              // never below the full-cut floor (0.02), never above unity.
              expect(point.value).toBeGreaterThanOrEqual(0.02);
              expect(point.value).toBeLessThanOrEqual(1);
            }
          }
        }
        for (const curve of [
          candidate.curves.filterA,
          candidate.curves.filterB,
        ]) {
          for (const point of curve) {
            expect(point.value).toBeGreaterThanOrEqual(30);
            expect(point.value).toBeLessThanOrEqual(20_000);
          }
        }
      }
    }
  });

  it("fx blocks use only the performer's param keys, per kind", () => {
    let fxSeen = 0;
    for (const { result } of allFixtureResults()) {
      for (const candidate of result.candidates) {
        for (const block of candidate.blocks) {
          if (block.type !== "fx") continue;
          fxSeen += 1;
          const keys = Object.keys(block.params);
          for (const key of keys) {
            expect(FX_PARAM_VOCABULARY).toContain(key);
            expect(FX_PARAM_KEYS_BY_KIND[block.kind]).toContain(key);
          }
          expect(keys).toContain("wet");
        }
      }
    }
    expect(fxSeen).toBeGreaterThan(0);
  });

  it("loop-blend spans sit inside the outgoing outro, exit anchor at the span's end", () => {
    let loopSeen = 0;
    for (const { a, result } of allFixtureResults()) {
      for (const candidate of result.candidates) {
        if (candidate.family !== "loop-blend") continue;
        loopSeen += 1;
        const loop = candidate.blocks.find((b) => b.type === "loop");
        expect(loop?.type).toBe("loop");
        if (loop?.type !== "loop" || !a.outro) continue;
        expect(loop.startMs).toBeGreaterThanOrEqual(a.outro.startMs);
        expect(loop.endMs).toBeLessThanOrEqual(a.outro.endMs);
        expect(candidate.outgoing.exitAnchorMs).toBe(loop.endMs);
      }
    }
    expect(loopSeen).toBeGreaterThan(0);
  });

  it("spinback jogs appear only as terminal side-A moves in stop-exit joins", () => {
    for (const { result } of allFixtureResults()) {
      for (const candidate of result.candidates) {
        for (const block of candidate.blocks) {
          if (block.type === "jog" && block.kind === "spinback") {
            expect(candidate.family).toBe("stop-exit");
            expect(block.side).toBe("A");
          }
        }
      }
    }
  });
});

describe("authors — degradation honesty (design §6)", () => {
  it("untrusted folk pair: rate-1 candidates only, NO beatmatched candidates", () => {
    const { candidates, rejected } = author(folkA, folkB);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.rates.beatmatched).toBe(false);
      expect(candidate.rates.rateA).toBe(1);
      expect(candidate.rates.rateB).toBe(1);
    }
    const families = new Set(candidates.map((c) => c.family));
    expect(families.has("filter-fade")).toBe(true);
    expect(families.has("echo-out")).toBe(true);
    expect(families.has("blend")).toBe(false);
    expect(families.has("loop-blend")).toBe(false);
    expect(families.has("drop-cut")).toBe(false);
    expect(
      rejected.some(
        (r) => r.family === "blend" && r.reason.includes("not trusted"),
      ),
    ).toBe(true);
  });

  it("distant keys cap every blend overlap at 8 beats", () => {
    const { candidates } = author(distantA, distantB);
    const blends = candidates.filter(
      (c) => c.family === "blend" || c.family === "loop-blend",
    );
    expect(blends.length).toBeGreaterThan(0);
    for (const blend of blends) {
      expect(blend.overlapBeats).toBeLessThanOrEqual(8);
    }
    expect(distantA.keyFitTo(distantB)?.compatible).toBe(false);
  });
});
