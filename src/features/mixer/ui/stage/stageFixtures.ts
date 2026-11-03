// Paired stage fixtures — Build 2A.
//
// Each fixture carries a StageSnapshot and the ActivitySnapshot that
// belongs with it, so narration and stage components can be exercised
// against the same moment without a live session.

import type { ActivitySnapshot } from "./stageData";
import type {
  StageEffectKind,
  StageEffectSnapshot,
  StageSnapshot,
} from "./stageSnapshot";
import { STAGE_EFFECT_KINDS } from "./stageSnapshot";

export interface StageFixture {
  snapshot: StageSnapshot;
  activity: ActivitySnapshot;
}

function unbuiltEffect(kind: StageEffectKind): StageEffectSnapshot {
  return {
    kind,
    built: false,
    wetLevel: null,
    sendLevels: { A: null, B: null },
    assign: null,
  };
}

function effectsWith(
  built: Partial<Record<StageEffectKind, Omit<StageEffectSnapshot, "kind">>>,
): StageEffectSnapshot[] {
  return STAGE_EFFECT_KINDS.map((kind) => {
    const override = built[kind];
    if (override) {
      return { kind, ...override };
    }
    return unbuiltEffect(kind);
  });
}

export const midBlendFixture: StageFixture = {
  snapshot: {
    decks: [
      {
        gainValue: 0.85,
        rateValue: 1,
        bassDb: -6,
        midDb: 0,
        highDb: 2,
        filterHz: 20000,
        meter: { peak: 0.8, rms: 0.5 },
        trackId: "current-song",
        positionSec: 42.5,
        tempoBias: 1,
        manualLoop: null,
        manualRollBeats: null,
      },
      {
        gainValue: 0.45,
        rateValue: 1.02,
        bassDb: -18,
        midDb: -4,
        highDb: 0,
        filterHz: 1200,
        meter: { peak: 0.6, rms: 0.3 },
        trackId: "next-song",
        positionSec: 3.25,
        tempoBias: 1,
        manualLoop: null,
        manualRollBeats: null,
      },
    ],
    master: {
      meter: { peak: 0.85, rms: 0.55 },
    },
    effects: effectsWith({
      reverb: {
        built: true,
        wetLevel: 0.55,
        sendLevels: { A: 0.5, B: 0 },
        assign: "A",
      },
      delay: {
        built: true,
        wetLevel: 0.4,
        sendLevels: { A: 0.45, B: 0 },
        assign: "A",
      },
      flanger: {
        built: true,
        wetLevel: 0.35,
        sendLevels: { A: 0, B: 0.35 },
        assign: "B",
      },
    }),
    currentMove: {
      label: "Performing a chirp scratch",
      family: "scratch",
      technique: "chirp",
    },
    crossfaderCurve: "constant-power",
    controlLevel: "autonomous",
    cue: { deckIndex: 1, meter: { peak: 0.6, rms: 0.3 } },
  },
  activity: {
    running: true,
    paused: false,
    blending: true,
    degraded: false,
    plainCutCount: 0,
    currentTitle: "Current Song",
    nextTitle: "Next Song",
    nextPrepared: true,
    openRequestCount: 0,
    endReason: null,
  },
};

export const idleFixture: StageFixture = {
  snapshot: {
    decks: [
      {
        gainValue: 0,
        rateValue: 1,
        bassDb: 0,
        midDb: 0,
        highDb: 0,
        filterHz: 20000,
        meter: null,
        trackId: null,
        positionSec: null,
        tempoBias: 1,
        manualLoop: null,
        manualRollBeats: null,
      },
      {
        gainValue: 0,
        rateValue: 1,
        bassDb: 0,
        midDb: 0,
        highDb: 0,
        filterHz: 20000,
        meter: null,
        trackId: null,
        positionSec: null,
        tempoBias: 1,
        manualLoop: null,
        manualRollBeats: null,
      },
    ],
    master: {
      meter: null,
    },
    effects: effectsWith({}),
    currentMove: null,
    crossfaderCurve: "smooth",
    controlLevel: "autonomous",
    cue: { deckIndex: 1, meter: null },
  },
  activity: {
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
  },
};

export const degradedFixture: StageFixture = {
  snapshot: {
    decks: [
      {
        gainValue: 1,
        rateValue: 1,
        bassDb: 0,
        midDb: 0,
        highDb: 0,
        filterHz: 20000,
        meter: { peak: 0.7, rms: 0.42 },
        trackId: "current-song",
        positionSec: 12,
        tempoBias: 1,
        manualLoop: null,
        manualRollBeats: null,
      },
      {
        gainValue: 0,
        rateValue: 1,
        bassDb: 0,
        midDb: 0,
        highDb: 0,
        filterHz: 20000,
        meter: null,
        trackId: null,
        positionSec: null,
        tempoBias: 1,
        manualLoop: null,
        manualRollBeats: null,
      },
    ],
    master: {
      meter: { peak: 0.7, rms: 0.4 },
    },
    effects: effectsWith({
      reverb: {
        built: true,
        wetLevel: 0.5,
        sendLevels: { A: 0.4, B: null },
        assign: null,
      },
    }),
    currentMove: null,
    crossfaderCurve: "smooth",
    controlLevel: "autonomous",
    cue: { deckIndex: 1, meter: null },
  },
  activity: {
    running: true,
    paused: false,
    blending: false,
    degraded: true,
    plainCutCount: 3,
    currentTitle: "Current Song",
    nextTitle: "Next Song",
    nextPrepared: false,
    openRequestCount: 0,
    endReason: null,
  },
};
