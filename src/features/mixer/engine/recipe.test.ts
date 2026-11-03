import { describe, expect, it } from "vitest";
import { planTransition, type TransitionPlan } from "./transitionPlanner";
import {
  automationValueAt,
  flatCurve,
  recipeFromPlan,
  validateRecipe,
  type AutomationCurve,
  type TransitionRecipe,
} from "./recipe";

// The recipe as data: validation, curve evaluation, and the legacy
// plan adapter — the artefact's own guarantees, pinned down.

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

describe("recipeFromPlan", () => {
  it("re-expresses the plan's geometry and rate strategy as recipe data", () => {
    const plan = planFixture();
    const recipe = recipeFromPlan(plan);
    expect(recipe.preset).toBe("beatmatched-fade");
    expect(recipe.overlap.startAMs).toBeNull(); // relative geometry, as documented
    expect(recipe.overlap.startBMs).toBe(plan.incomingStartSec * 1000);
    expect(recipe.overlap.durationMs).toBe(plan.blendDurationSec * 1000);
    expect(recipe.overlap.rateB).toBe(plan.incomingRate);
    expect(recipe.leadInSec).toBe(plan.startsInSec);
    expect(recipe.fingerprints).toEqual({
      aAudioHash: null,
      bAudioHash: null,
      analysisVersion: null,
    });
    expect(recipe.evidence.vocalOverlap).toBe(plan.vocalOverlap ? 1 : 0);
    expect(validateRecipe(recipe)).toEqual([]);
  });

  it("holds the rate across the blend and returns it over the plan's return duration", () => {
    const plan = planFixture();
    const recipe = recipeFromPlan(plan);
    const rate = recipe.automation.rateB;
    expect(automationValueAt(rate, 0)).toBe(plan.incomingRate);
    expect(automationValueAt(rate, plan.blendDurationSec * 1000)).toBe(
      plan.incomingRate,
    );
    const endMs =
      plan.blendDurationSec * 1000 + plan.rateReturnDurationSec * 1000;
    expect(automationValueAt(rate, endMs)).toBe(1);
    // Halfway through the return, the rate is halfway home.
    const midReturnMs =
      plan.blendDurationSec * 1000 + plan.rateReturnDurationSec * 500;
    expect(automationValueAt(rate, midReturnMs)).toBeCloseTo(
      (plan.incomingRate + 1) / 2,
      6,
    );
  });

  it("swaps the bass at the plan's swap point", () => {
    const plan = planFixture();
    const recipe = recipeFromPlan(plan);
    const swapMs = (plan.bassSwapInSec - plan.startsInSec) * 1000;
    expect(automationValueAt(recipe.automation.eqIn.low, swapMs - 1)).toBe(-32);
    expect(automationValueAt(recipe.automation.eqIn.low, swapMs + 25)).toBe(0);
    expect(automationValueAt(recipe.automation.eqOut.low, swapMs - 1)).toBe(0);
    expect(automationValueAt(recipe.automation.eqOut.low, swapMs + 25)).toBe(
      -32,
    );
  });

  it("is pure data: a JSON round-trip changes nothing", () => {
    const recipe = recipeFromPlan(planFixture());
    expect(JSON.parse(JSON.stringify(recipe))).toEqual(recipe);
  });
});

describe("validateRecipe", () => {
  const valid = (): TransitionRecipe => recipeFromPlan(planFixture());

  it("accepts the adapted plan recipe", () => {
    expect(validateRecipe(valid())).toEqual([]);
  });

  it("rejects a negative overlap and an out-of-range rate", () => {
    const recipe = valid();
    recipe.overlap.durationMs = -5;
    recipe.overlap.rateB = 3;
    const errors = validateRecipe(recipe);
    expect(errors.some((e) => e.includes("durationMs"))).toBe(true);
    expect(errors.some((e) => e.includes("rateB"))).toBe(true);
  });

  it("rejects curve values outside their kind's range", () => {
    const recipe = valid();
    recipe.automation.volumeIn.points[0].value = 9;
    expect(validateRecipe(recipe).some((e) => e.includes("volumeIn"))).toBe(
      true,
    );
  });

  it("rejects an echo whose feedback would ring forever", () => {
    const recipe = valid();
    recipe.fx.echo = {
      delaySec: 0.375,
      feedback: 0.95,
      wet: 0.5,
      divisionBeats: 0.75,
    };
    expect(validateRecipe(recipe).some((e) => e.includes("feedback"))).toBe(
      true,
    );
  });

  it("rejects a loop that ends before it starts", () => {
    const recipe = valid();
    recipe.loops.push({
      type: "loop",
      side: "A",
      startMs: 5000,
      endMs: 4000,
      beats: 8,
    });
    expect(validateRecipe(recipe).some((e) => e.includes("loop"))).toBe(true);
  });
});

describe("automationValueAt", () => {
  const curve = (
    points: [number, number, ("linear" | "power-in" | "smooth")?][],
  ): AutomationCurve => ({
    kind: "linear-gain",
    unit: "linear",
    points: points.map(([atMs, value, easing]) => ({ atMs, value, easing })),
  });

  it("interpolates linearly by default and holds the ends", () => {
    const c = curve([
      [0, 0],
      [1000, 1],
    ]);
    expect(automationValueAt(c, -5)).toBe(0);
    expect(automationValueAt(c, 500)).toBeCloseTo(0.5);
    expect(automationValueAt(c, 2000)).toBe(1);
  });

  it("applies the easing declared on the point the segment leaves", () => {
    const c = curve([
      [0, 0, "power-in"],
      [1000, 1],
    ]);
    expect(automationValueAt(c, 500)).toBeCloseTo(0.25); // t² at t=0.5
  });

  it("treats duplicated times as steps — the last point wins", () => {
    const c = curve([
      [0, 1],
      [0, 0],
      [1000, 0],
    ]);
    expect(automationValueAt(c, 0)).toBe(0);
  });

  it("reads a flat curve as its value everywhere", () => {
    const c = flatCurve("eq-gain", "decibels", -3);
    expect(automationValueAt(c, 0)).toBe(-3);
    expect(automationValueAt(c, 9999)).toBe(-3);
  });
});
