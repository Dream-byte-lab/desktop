import { describe, expect, it } from "vitest";
import {
  degradedFixture,
  idleFixture,
  midBlendFixture,
  type StageFixture,
} from "./stageFixtures";
import {
  STAGE_EFFECT_KINDS,
  deckForSide,
  effectByKind,
  meterDbfs,
  meterFraction,
  sideForDeck,
} from "./stageSnapshot";

const fixtures: Array<[string, StageFixture]> = [
  ["midBlendFixture", midBlendFixture],
  ["idleFixture", idleFixture],
  ["degradedFixture", degradedFixture],
];

describe("stage fixtures — effects", () => {
  for (const [name, fixture] of fixtures) {
    it(`${name} carries exactly the eight effects in STAGE_EFFECT_KINDS order`, () => {
      expect(fixture.snapshot.effects).toHaveLength(8);
      expect(fixture.snapshot.effects.map((effect) => effect.kind)).toEqual([
        ...STAGE_EFFECT_KINDS,
      ]);
      for (const kind of STAGE_EFFECT_KINDS) {
        expect(effectByKind(fixture.snapshot, kind)?.kind).toBe(kind);
      }
    });
  }
});

describe("idleFixture", () => {
  it("has every meter null", () => {
    expect(idleFixture.snapshot.decks[0].meter).toBeNull();
    expect(idleFixture.snapshot.decks[1].meter).toBeNull();
    expect(idleFixture.snapshot.master.meter).toBeNull();
  });

  it("has every effect unbuilt with null wet level and null sends", () => {
    for (const effect of idleFixture.snapshot.effects) {
      expect(effect.built).toBe(false);
      expect(effect.wetLevel).toBeNull();
      expect(effect.sendLevels).toEqual({ A: null, B: null });
      expect(effect.assign).toBeNull();
    }
  });

  it("is not running and knows no current move", () => {
    expect(idleFixture.snapshot.currentMove).toBeNull();
    expect(idleFixture.snapshot.crossfaderCurve).toBe("smooth");
    expect(idleFixture.activity).toEqual({
      running: false,
      paused: false,
      blending: false,
      degraded: false,
      plainCutCount: 0,
      currentTitle: null,
      nextTitle: null,
      nextPrepared: false,
      openRequestCount: 0,
      endReason: null,
    });
  });

  it("has silent, flat decks", () => {
    for (const deck of idleFixture.snapshot.decks) {
      expect(deck.gainValue).toBe(0);
      expect(deck.rateValue).toBe(1);
      expect(deck.bassDb).toBe(0);
      expect(deck.midDb).toBe(0);
      expect(deck.highDb).toBe(0);
      expect(deck.filterHz).toBe(20000);
    }
  });
});

describe("midBlendFixture", () => {
  it("has the three built effects with the stated values", () => {
    const { snapshot } = midBlendFixture;

    expect(effectByKind(snapshot, "reverb")).toEqual({
      kind: "reverb",
      built: true,
      wetLevel: 0.55,
      sendLevels: { A: 0.5, B: 0 },
      assign: "A",
    });
    expect(effectByKind(snapshot, "delay")).toEqual({
      kind: "delay",
      built: true,
      wetLevel: 0.4,
      sendLevels: { A: 0.45, B: 0 },
      assign: "A",
    });
    expect(effectByKind(snapshot, "flanger")).toEqual({
      kind: "flanger",
      built: true,
      wetLevel: 0.35,
      sendLevels: { A: 0, B: 0.35 },
      assign: "B",
    });
  });

  it("has the other five effects unbuilt with null values", () => {
    const { snapshot } = midBlendFixture;
    for (const kind of [
      "phaser",
      "distortion",
      "spiral",
      "trans",
      "roll",
    ] as const) {
      expect(effectByKind(snapshot, kind)).toEqual({
        kind,
        built: false,
        wetLevel: null,
        sendLevels: { A: null, B: null },
        assign: null,
      });
    }
  });

  it("has the stated decks, master meter, move and curve", () => {
    const { snapshot, activity } = midBlendFixture;

    expect(snapshot.decks[0]).toEqual({
      gainValue: 0.85,
      rateValue: 1,
      bassDb: -6,
      midDb: 0,
      highDb: 2,
      filterHz: 20000,
      meter: { peak: 0.8, rms: 0.5 },
    });
    expect(snapshot.decks[1]).toEqual({
      gainValue: 0.45,
      rateValue: 1.02,
      bassDb: -18,
      midDb: -4,
      highDb: 0,
      filterHz: 1200,
      meter: { peak: 0.6, rms: 0.3 },
    });
    expect(snapshot.master.meter).toEqual({ peak: 0.85, rms: 0.55 });
    expect(snapshot.currentMove).toEqual({
      label: "Performing a chirp scratch",
      family: "scratch",
      technique: "chirp",
    });
    expect(snapshot.crossfaderCurve).toBe("constant-power");
    expect(activity.running).toBe(true);
    expect(activity.blending).toBe(true);
    expect(activity.nextPrepared).toBe(true);
    expect(activity.currentTitle).not.toBeNull();
    expect(activity.nextTitle).not.toBeNull();
  });
});

describe("degradedFixture", () => {
  it("has the stated degraded activity and no current move", () => {
    expect(degradedFixture.activity.degraded).toBe(true);
    expect(degradedFixture.activity.plainCutCount).toBe(3);
    expect(degradedFixture.activity.nextPrepared).toBe(false);
    expect(degradedFixture.activity.running).toBe(true);
    expect(degradedFixture.snapshot.currentMove).toBeNull();
    expect(degradedFixture.snapshot.crossfaderCurve).toBe("smooth");
  });

  it("has a live deck A, a silent deck B with no meter, and a master meter", () => {
    const { snapshot } = degradedFixture;
    expect(snapshot.decks[0].gainValue).toBe(1);
    expect(snapshot.decks[0].meter).toEqual({ peak: 0.7, rms: 0.42 });
    expect(snapshot.decks[1].gainValue).toBe(0);
    expect(snapshot.decks[1].meter).toBeNull();
    expect(snapshot.master.meter).toEqual({ peak: 0.7, rms: 0.4 });
  });

  it("has only reverb built, with a null B send and no assign", () => {
    const { snapshot } = degradedFixture;
    expect(effectByKind(snapshot, "reverb")).toEqual({
      kind: "reverb",
      built: true,
      wetLevel: 0.5,
      sendLevels: { A: 0.4, B: null },
      assign: null,
    });
    for (const effect of snapshot.effects) {
      if (effect.kind === "reverb") continue;
      expect(effect.built).toBe(false);
      expect(effect.wetLevel).toBeNull();
      expect(effect.sendLevels).toEqual({ A: null, B: null });
      expect(effect.assign).toBeNull();
    }
  });
});

describe("stageSnapshot helpers", () => {
  it("meterFraction maps silence to 0 and full scale to 1", () => {
    expect(meterFraction(0)).toBe(0);
    expect(meterFraction(1)).toBe(1);
  });

  it("meterFraction maps 0.5 to approximately 0.8997", () => {
    expect(meterFraction(0.5)).toBeCloseTo(0.8997, 3);
  });

  it("meterDbfs maps 0 to -Infinity", () => {
    expect(meterDbfs(0)).toBe(-Infinity);
  });

  it("sideForDeck and deckForSide round-trip both decks", () => {
    expect(sideForDeck(0)).toBe("A");
    expect(sideForDeck(1)).toBe("B");
    expect(deckForSide("A")).toBe(0);
    expect(deckForSide("B")).toBe(1);
    expect(deckForSide(sideForDeck(0))).toBe(0);
    expect(deckForSide(sideForDeck(1))).toBe(1);
    expect(sideForDeck(deckForSide("A"))).toBe("A");
    expect(sideForDeck(deckForSide("B"))).toBe("B");
  });
});
