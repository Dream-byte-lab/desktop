// The stage snapshot contract — Build 2A.
//
// This file is the SINGLE SOURCE the session-exposure unlock slice
// implements against. DJ Stage Build 1 (investigation/
// dj-stage-build1.md) found that everything on the stage's second
// half — EQ/filter reflection, level meters, the FX monitor bank,
// named-move narration — gates on one read-only exposure on
// DjSession: either `get mixerForStage(): TwoDeckMixer | null` or a
// `stageSnapshot()` returning the shape below. Build 2A builds the
// whole stage side of that contract ahead of the wiring, so the
// unlock slice only has to PRODUCE this data and mount
// StageSnapshotControls with it.
//
// Discipline carried over from Build 1 and R3:
// - Components are pure: they render this data and emit intents
//   through StageControlIntents. Nothing here calls the engine.
// - Absence is data, never a guess. A meter summary of null means
//   no analyser path exists for that deck yet (R3's lazy ethos:
//   taps are built when first needed, and until then the honest
//   state is "no meter path"). An effect's `built: false` means
//   its shared network has never been constructed this session.
// - Narration text (StageCurrentMove.label) is written by the
//   session from the standing recipe/decision. Components render
//   it verbatim; they never invent move names.

import type { RecipeEffectKind } from "../../engine/recipe";

/** The eight R3 effects, in the R3 report's order. */
export type StageEffectKind = RecipeEffectKind;

export const STAGE_EFFECT_KINDS: readonly StageEffectKind[] = [
  "reverb",
  "delay",
  "flanger",
  "phaser",
  "distortion",
  "spiral",
  "trans",
  "roll",
];

export const STAGE_EFFECT_LABELS: Record<StageEffectKind, string> = {
  reverb: "Reverb",
  delay: "Delay",
  flanger: "Flanger",
  phaser: "Phaser",
  distortion: "Distortion",
  spiral: "Spiral",
  trans: "Trans",
  roll: "Roll",
};

export type StageDeckIndex = 0 | 1;
export type StageDeckSide = "A" | "B";

export function sideForDeck(index: StageDeckIndex): StageDeckSide {
  return index === 0 ? "A" : "B";
}

export function deckForSide(side: StageDeckSide): StageDeckIndex {
  return side === "A" ? 0 : 1;
}

/**
 * Peak/RMS amplitude summary for one meter, as DATA. The snapshot
 * carries the numbers an analyser tap produced; the stage never
 * owns an AnalyserNode. Values are linear amplitudes (1.0 = full
 * scale); conversion to display fractions lives in the helpers
 * below so every meter reads the same scale.
 */
export interface StageMeterSummary {
  peak: number;
  rms: number;
}

export interface StageDeckSnapshot {
  /** The deck gain's current value (the blend curves write it). */
  gainValue: number;
  /** The deck's current playback-rate ratio (1 = original tempo). */
  rateValue: number;
  /** EQ band gains in dB, as the deck's biquads currently hold them. */
  bassDb: number;
  midDb: number;
  highDb: number;
  /** Lowpass filter cutoff in Hz (20,000 = fully open, its rest). */
  filterHz: number;
  /** Meter summary, or null when no analyser tap exists yet. */
  meter: StageMeterSummary | null;
}

export interface StageMasterSnapshot {
  /** Master meter summary, or null when no tap exists yet. */
  meter: StageMeterSummary | null;
}

/** Where an effect's manual focus sits: one deck, both, or none. */
export type StageFxAssign = StageDeckSide | "both" | null;

export interface StageEffectSnapshot {
  kind: StageEffectKind;
  /** The shared network exists (R3 builds them lazily). */
  built: boolean;
  /**
   * The network's shared wet-return level, 0..1, or null when the
   * network is unbuilt or the value is not readable.
   */
  wetLevel: number | null;
  /** Per-deck send levels, 0..1, or null per side when unreadable. */
  sendLevels: { A: number | null; B: number | null };
  /** The manual assign the wiring slice's manual FX stage reports. */
  assign: StageFxAssign;
}

export interface StageCurrentMove {
  /**
   * Plain-language narration of the standing decision, written by
   * the session — e.g. "Performing a chirp scratch", "Vinyl stop
   * into the next track". Rendered verbatim, never paraphrased.
   */
  label: string;
  /** The decision family behind the move (e.g. "fx", "scratch"), if known. */
  family: string | null;
  /** The technique inside the family (e.g. "chirp"), if known. */
  technique: string | null;
}

export type StageCrossfaderCurve = "smooth" | "constant-power" | "cut";

export interface StageSnapshot {
  decks: [StageDeckSnapshot, StageDeckSnapshot];
  master: StageMasterSnapshot;
  /** One entry per kind, in STAGE_EFFECT_KINDS order. */
  effects: StageEffectSnapshot[];
  /** The standing decision's narration, or null when none is known. */
  currentMove: StageCurrentMove | null;
  crossfaderCurve: StageCrossfaderCurve;
}

export type StageEqBand = "bass" | "mid" | "high";

/**
 * Every way the stage asks the world to change. The wiring slice
 * routes these to the session's manual stage (the setDeckTrim
 * pattern) once the exposure exists; until then the components
 * that emit them are rendered only in tests and fixtures.
 */
export interface StageControlIntents {
  /** Trim as a ratio (1 = unity, 1.25 = the manual stage's max). */
  onTrimChange: (deck: StageDeckIndex, ratio: number) => void;
  onEqChange: (deck: StageDeckIndex, band: StageEqBand, db: number) => void;
  onFilterChange: (deck: StageDeckIndex, hz: number) => void;
  onCrossfaderCurveChange: (curve: StageCrossfaderCurve) => void;
  onFxAssign: (kind: StageEffectKind, assign: StageFxAssign) => void;
  /** A per-deck send level for an effect, 0..1. */
  onFxWetLevel: (
    kind: StageEffectKind,
    side: StageDeckSide,
    level: number,
  ) => void;
}

/** UI display range for the EQ knobs, in dB (centre 0 = flat). */
export const STAGE_EQ_MIN_DB = -24;
export const STAGE_EQ_MAX_DB = 24;
/** UI range for the filter knob, in Hz, swept logarithmically. */
export const STAGE_FILTER_MIN_HZ = 60;
export const STAGE_FILTER_MAX_HZ = 20_000;

/** dBFS for a linear amplitude; silence and non-finite input floor out. */
export function meterDbfs(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 0) return -Infinity;
  return 20 * Math.log10(linear);
}

/**
 * Display fraction for a linear amplitude on the meter scale:
 * 0 at or below −60 dBFS, 1 at 0 dBFS, clamped between.
 */
export function meterFraction(linear: number): number {
  const db = meterDbfs(linear);
  if (db === -Infinity) return 0;
  return Math.min(1, Math.max(0, (db + 60) / 60));
}

/** The snapshot's effect entry for one kind, if it carries one. */
export function effectByKind(
  snapshot: StageSnapshot,
  kind: StageEffectKind,
): StageEffectSnapshot | undefined {
  return snapshot.effects.find((effect) => effect.kind === kind);
}
