import { describe, expect, it } from "vitest";
import { planTransition, type TransitionPlan } from "./transitionPlanner";
import {
  recipeFromPlan,
  validateRecipe,
  type RecipeEffectBlock,
  type TransitionRecipe,
} from "./recipe";

// The revamp's R3 — the effect vocabulary as data: every config's
// range, and the block rules that keep a recipe performable (no
// orphans, no shared-network fights, no same-send overlaps).

function planFixture(): TransitionPlan {
  const plan = planTransition({
    outgoing: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    outgoingPositionSec: 60,
    incoming: { bpm: 125, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    incomingEntryBeat: 32,
  });
  if (!plan) throw new Error("fixture plan should exist");
  return plan;
}

const valid = (): TransitionRecipe => recipeFromPlan(planFixture());

function block(
  kind: RecipeEffectBlock["kind"],
  side: "A" | "B",
  startMs: number,
  endMs: number,
): RecipeEffectBlock {
  return { kind, side, startMs, endMs, beats: 4, level: 0.8 };
}

describe("validateRecipe — R3 fx configs", () => {
  it("rejects a reverb outside its ranges", () => {
    const a = valid();
    a.fx.reverb = { decaySec: 0, wet: 0.5 };
    expect(
      validateRecipe(a).some((e) => e.includes("fx.reverb.decaySec")),
    ).toBe(true);
    const b = valid();
    b.fx.reverb = { decaySec: 9, wet: 0.5 };
    expect(
      validateRecipe(b).some((e) => e.includes("fx.reverb.decaySec")),
    ).toBe(true);
    const c = valid();
    c.fx.reverb = { decaySec: 2, wet: 1.5 };
    expect(validateRecipe(c).some((e) => e.includes("fx.reverb.wet"))).toBe(
      true,
    );
  });

  it("rejects a delay outside its ranges", () => {
    const a = valid();
    a.fx.delay = { delaySec: 0, feedback: 0.4, wet: 0.5 };
    expect(validateRecipe(a).some((e) => e.includes("fx.delay.delaySec"))).toBe(
      true,
    );
    const b = valid();
    b.fx.delay = { delaySec: 0.375, feedback: 0.9, wet: 0.5 };
    expect(validateRecipe(b).some((e) => e.includes("fx.delay.feedback"))).toBe(
      true,
    );
    const c = valid();
    c.fx.delay = { delaySec: 0.375, feedback: 0.4, wet: -0.1 };
    expect(validateRecipe(c).some((e) => e.includes("fx.delay.wet"))).toBe(
      true,
    );
  });

  it("rejects a flanger outside its ranges", () => {
    const a = valid();
    a.fx.flanger = { rateHz: 0, depthMs: 2, feedback: 0.3, wet: 0.5 };
    expect(validateRecipe(a).some((e) => e.includes("fx.flanger.rateHz"))).toBe(
      true,
    );
    const b = valid();
    b.fx.flanger = { rateHz: 2, depthMs: 6, feedback: 0.3, wet: 0.5 };
    expect(
      validateRecipe(b).some((e) => e.includes("fx.flanger.depthMs")),
    ).toBe(true);
    const c = valid();
    c.fx.flanger = { rateHz: 2, depthMs: 2, feedback: 0.9, wet: 0.5 };
    expect(
      validateRecipe(c).some((e) => e.includes("fx.flanger.feedback")),
    ).toBe(true);
    const d = valid();
    d.fx.flanger = { rateHz: 2, depthMs: 2, feedback: 0.3, wet: 2 };
    expect(validateRecipe(d).some((e) => e.includes("fx.flanger.wet"))).toBe(
      true,
    );
  });

  it("rejects a phaser outside its ranges", () => {
    const a = valid();
    a.fx.phaser = { rateHz: 6, depth: 0.5, wet: 0.5 };
    expect(validateRecipe(a).some((e) => e.includes("fx.phaser.rateHz"))).toBe(
      true,
    );
    const b = valid();
    b.fx.phaser = { rateHz: 1, depth: 1.5, wet: 0.5 };
    expect(validateRecipe(b).some((e) => e.includes("fx.phaser.depth"))).toBe(
      true,
    );
    const c = valid();
    c.fx.phaser = { rateHz: 1, depth: 0.5, wet: -1 };
    expect(validateRecipe(c).some((e) => e.includes("fx.phaser.wet"))).toBe(
      true,
    );
  });

  it("rejects a distortion outside its ranges", () => {
    const a = valid();
    a.fx.distortion = { amount: 1.5, wet: 0.5 };
    expect(
      validateRecipe(a).some((e) => e.includes("fx.distortion.amount")),
    ).toBe(true);
    const b = valid();
    b.fx.distortion = { amount: 0.5, wet: -0.5 };
    expect(validateRecipe(b).some((e) => e.includes("fx.distortion.wet"))).toBe(
      true,
    );
  });

  it("rejects a spiral outside its ranges", () => {
    const a = valid();
    a.fx.spiral = { delaySec: 3, sweepToRatio: 0.5, feedback: 0.3, wet: 0.5 };
    expect(
      validateRecipe(a).some((e) => e.includes("fx.spiral.delaySec")),
    ).toBe(true);
    const b = valid();
    b.fx.spiral = { delaySec: 0.5, sweepToRatio: 0.1, feedback: 0.3, wet: 0.5 };
    expect(
      validateRecipe(b).some((e) => e.includes("fx.spiral.sweepToRatio")),
    ).toBe(true);
    const c = valid();
    c.fx.spiral = { delaySec: 0.5, sweepToRatio: 0.5, feedback: 0.9, wet: 0.5 };
    expect(
      validateRecipe(c).some((e) => e.includes("fx.spiral.feedback")),
    ).toBe(true);
  });

  it("rejects a trans outside its ranges", () => {
    const a = valid();
    a.fx.trans = { divisionBeats: 0.1, depth: 0.8 };
    expect(
      validateRecipe(a).some((e) => e.includes("fx.trans.divisionBeats")),
    ).toBe(true);
    const b = valid();
    b.fx.trans = { divisionBeats: 1, depth: 0 };
    expect(validateRecipe(b).some((e) => e.includes("fx.trans.depth"))).toBe(
      true,
    );
    const c = valid();
    c.fx.trans = { divisionBeats: 1, depth: 1.5 };
    expect(validateRecipe(c).some((e) => e.includes("fx.trans.depth"))).toBe(
      true,
    );
  });

  it("rejects a roll outside its ranges", () => {
    const a = valid();
    a.fx.roll = { sliceBeats: 0.1, feedback: 0.9 };
    expect(
      validateRecipe(a).some((e) => e.includes("fx.roll.sliceBeats")),
    ).toBe(true);
    const b = valid();
    b.fx.roll = { sliceBeats: 0.5, feedback: 0.5 };
    expect(validateRecipe(b).some((e) => e.includes("fx.roll.feedback"))).toBe(
      true,
    );
    const c = valid();
    c.fx.roll = { sliceBeats: 0.5, feedback: 1 };
    expect(validateRecipe(c).some((e) => e.includes("fx.roll.feedback"))).toBe(
      true,
    );
  });
});

describe("validateRecipe — R3 effect blocks", () => {
  it("rejects an orphan block — a window with no config to perform it", () => {
    const recipe = valid();
    recipe.effects = [block("delay", "A", 0, 2000)];
    expect(validateRecipe(recipe).some((e) => e.includes("fx.delay"))).toBe(
      true,
    );
  });

  it("rejects a block that ends before it starts, has no beats, or is out of level", () => {
    const recipe = valid();
    recipe.fx.reverb = { decaySec: 2, wet: 0.4 };
    recipe.effects = [
      {
        kind: "reverb",
        side: "A",
        startMs: 2000,
        endMs: 1000,
        beats: 0,
        level: 2,
      },
    ];
    const errors = validateRecipe(recipe);
    expect(errors.some((e) => e.includes("endMs"))).toBe(true);
    expect(errors.some((e) => e.includes("beats"))).toBe(true);
    expect(errors.some((e) => e.includes("level"))).toBe(true);
  });

  it("rejects two roll blocks — they would fight over the one roll network", () => {
    const recipe = valid();
    recipe.fx.roll = { sliceBeats: 0.5, feedback: 0.9 };
    recipe.effects = [
      block("roll", "B", 0, 1000),
      block("roll", "B", 2000, 3000),
    ];
    expect(validateRecipe(recipe).some((e) => e.includes("roll"))).toBe(true);
  });

  it("rejects two spiral blocks — they would fight over the one spiral network", () => {
    const recipe = valid();
    recipe.fx.spiral = {
      delaySec: 0.5,
      sweepToRatio: 0.5,
      feedback: 0.3,
      wet: 0.5,
    };
    recipe.effects = [
      block("spiral", "A", 0, 1000),
      block("spiral", "B", 2000, 3000),
    ];
    expect(validateRecipe(recipe).some((e) => e.includes("spiral"))).toBe(true);
  });

  it("rejects two blocks of the same kind on the same side that overlap in time", () => {
    const recipe = valid();
    recipe.fx.reverb = { decaySec: 2, wet: 0.4 };
    recipe.effects = [
      block("reverb", "A", 0, 2000),
      block("reverb", "A", 1000, 3000),
    ];
    expect(validateRecipe(recipe).some((e) => e.includes("overlap"))).toBe(
      true,
    );
  });

  it("accepts the same kind on DIFFERENT sides at the same time — different sends, no fight", () => {
    const recipe = valid();
    recipe.fx.reverb = { decaySec: 2, wet: 0.4 };
    recipe.effects = [
      block("reverb", "A", 0, 2000),
      block("reverb", "B", 0, 2000),
    ];
    expect(validateRecipe(recipe)).toEqual([]);
  });

  it("accepts a valid full chain recipe", () => {
    const recipe = valid();
    recipe.fx = {
      reverb: { decaySec: 2, wet: 0.4 },
      delay: { delaySec: 0.375, feedback: 0.4, wet: 0.5 },
      flanger: { rateHz: 2, depthMs: 2, feedback: 0.3, wet: 0.5 },
      phaser: { rateHz: 1.5, depth: 0.8, wet: 0.5 },
      distortion: { amount: 0.7, wet: 0.5 },
      spiral: { delaySec: 0.5, sweepToRatio: 0.5, feedback: 0.3, wet: 0.6 },
      trans: { divisionBeats: 1, depth: 0.8 },
      roll: { sliceBeats: 0.5, feedback: 0.9 },
      chainDelayIntoReverb: true,
    };
    recipe.effects = [
      block("reverb", "A", 0, 1000),
      block("delay", "B", 0, 1000),
      block("flanger", "A", 2000, 3000),
      block("phaser", "B", 2000, 3000),
      block("distortion", "A", 4000, 5000),
      block("spiral", "B", 4000, 5000),
      block("trans", "A", 6000, 7000),
      { ...block("roll", "B", 6000, 7000), level: 0.8 },
    ];
    expect(validateRecipe(recipe)).toEqual([]);
  });
});
