// recipe.ts — the liveRave join document (Wave 1 foundation).
//
// A JoinRecipe is the complete, self-describing plan for one join:
// which tracks, which anchors, how long the overlap runs, the
// sustained beatmatch rates, every keyframed curve in beat space,
// and every block (loops, jogs, scratches, fx) the performer must
// schedule. Authors write recipes; the brain draws among them; the
// performer executes them. Written fresh for the rebuild — it does
// not import or copy the old engine's recipe type.
//
// validateRecipe checks STRUCTURE ONLY: finite numbers, ordered
// points and spans, anchors inside the tracks' known durations,
// blocks inside the spans they claim, rates inside [0.5, 2]. It
// makes NO musical judgement — a harmonically wild, one-beat,
// painfully loud recipe that is structurally sound validates clean,
// because taste belongs to the authors and the draw, never to a
// gatekeeper at the deck door (design §3.2 / §4 invariant 2).
//
// Environment-pure: no DOM, no storage, no worker globals.

import type { TrackFacts } from "./facts";

// ---------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------

export type JoinFamily =
  | "blend"
  | "loop-blend"
  | "drop-cut"
  | "filter-fade"
  | "echo-out"
  | "stop-exit"
  | "scratch-in"
  | "scratch-out";

export const JOIN_FAMILIES: readonly JoinFamily[] = [
  "blend",
  "loop-blend",
  "drop-cut",
  "filter-fade",
  "echo-out",
  "stop-exit",
  "scratch-in",
  "scratch-out",
];

export type ScratchTechnique =
  "baby" | "chirp" | "transformer" | "flare" | "crab";

export const SCRATCH_TECHNIQUES: readonly ScratchTechnique[] = [
  "baby",
  "chirp",
  "transformer",
  "flare",
  "crab",
];

export type JogKind = "nudge" | "brake" | "vinyl-stop" | "spinback";

export const JOG_KINDS: readonly JogKind[] = [
  "nudge",
  "brake",
  "vinyl-stop",
  "spinback",
];

export type FxKind =
  | "reverb"
  | "delay"
  | "spiral"
  | "flanger"
  | "phaser"
  | "saturation"
  | "gating"
  | "slip-roll";

export const FX_KINDS: readonly FxKind[] = [
  "reverb",
  "delay",
  "spiral",
  "flanger",
  "phaser",
  "saturation",
  "gating",
  "slip-roll",
];

/** Deck side within a join: "A" is the outgoing track, "B" the incoming. */
export type RecipeSide = "A" | "B";

// ---------------------------------------------------------------------
// Curves — keyframed point lists in beat space
// ---------------------------------------------------------------------

export type CurveEasing = "linear" | "step";

export interface CurvePoint {
  /** Beat position within the join (0 = the overlap's first beat). */
  atBeat: number;
  value: number;
  /**
   * How the segment FROM this point to the next is traversed:
   * "linear" (default) interpolates; "step" holds this point's value
   * until the next point.
   */
  easing?: CurveEasing;
}

export type KeyframedCurve = CurvePoint[];

export interface EqCurves {
  low: KeyframedCurve;
  mid: KeyframedCurve;
  high: KeyframedCurve;
}

export interface JoinCurves {
  gainA: KeyframedCurve;
  gainB: KeyframedCurve;
  eqA: EqCurves;
  eqB: EqCurves;
  filterA: KeyframedCurve;
  filterB: KeyframedCurve;
}

/**
 * Evaluates a keyframed curve at a beat. Before the first point the
 * first value holds; after the last point the last value holds;
 * between points the segment interpolates linearly unless its
 * starting point carries easing "step", in which case the starting
 * value holds until the next point. An empty curve evaluates to 0.
 * Points are assumed ordered by atBeat (validateRecipe enforces it).
 */
export function valueAt(points: readonly CurvePoint[], beat: number): number {
  if (points.length === 0 || !Number.isFinite(beat)) return 0;
  if (beat <= points[0].atBeat) return points[0].value;
  const last = points[points.length - 1];
  if (beat >= last.atBeat) return last.value;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (beat >= a.atBeat && beat < b.atBeat) {
      if (a.easing === "step") return a.value;
      const span = b.atBeat - a.atBeat;
      if (span <= 0) return b.value;
      const t = (beat - a.atBeat) / span;
      return a.value + t * (b.value - a.value);
    }
  }
  return last.value;
}

// ---------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------

export interface LoopBlock {
  type: "loop";
  side: RecipeSide;
  startMs: number;
  endMs: number;
  /** How many times the span wraps (integer >= 1). */
  wraps: number;
}

export interface JogBlock {
  type: "jog";
  side: RecipeSide;
  kind: JogKind;
  atBeat: number;
  beats: number;
  /** Sustained bend for a nudge, e.g. 0.97 or 1.03 (rate multiplier). */
  bend?: number;
  /** Peak playback rate for brake / vinyl-stop / spinback moves. */
  peakRate?: number;
}

export interface ScratchBlock {
  type: "scratch";
  side: RecipeSide;
  technique: ScratchTechnique;
  atBeat: number;
  beats: number;
  /** The audio window being scratched, in that side's track time. */
  windowStartMs: number;
  windowEndMs: number;
}

export interface FxBlock {
  type: "fx";
  /** A deck side, or "tail" for the shared tail bus. */
  side: RecipeSide | "tail";
  kind: FxKind;
  atBeat: number;
  beats: number;
  /** Effect parameters; every value must be a finite number. */
  params: Record<string, number>;
}

export type JoinBlock = LoopBlock | JogBlock | ScratchBlock | FxBlock;

// ---------------------------------------------------------------------
// The recipe document
// ---------------------------------------------------------------------

export interface OutgoingRef {
  trackId: string;
  audioHash: string | null;
  /** Where the outgoing track leaves, in its own track time. */
  exitAnchorMs: number;
  exitBeat: number;
}

export interface IncomingRef {
  trackId: string;
  audioHash: string | null;
  /** Where the incoming track enters, in its own track time. */
  entryAnchorMs: number;
  entryBeat: number;
}

export interface JoinRates {
  /** Sustained playback rate for the outgoing side (1 = unbent). */
  rateA: number;
  /** Sustained playback rate for the incoming side (1 = unbent). */
  rateB: number;
  /** True when the two rates are a deliberate beatmatch pair. */
  beatmatched: boolean;
}

export interface RecipeAuthorship {
  /** Raw evidence components the author computed, by name, in [0,1]. */
  evidence: Record<string, number>;
  /** Free-form generation notes (debug/audit surface). */
  notes: string[];
}

export interface JoinRecipe {
  id: string;
  family: JoinFamily;
  /** Scratch technique, when the family/technique calls for one. */
  technique?: ScratchTechnique;
  outgoing: OutgoingRef;
  incoming: IncomingRef;
  /** Length of the overlap in beats (>= 0; a hard cut may be 0). */
  overlapBeats: number;
  rates: JoinRates;
  curves: JoinCurves;
  blocks: JoinBlock[];
  authored: RecipeAuthorship;
}

// ---------------------------------------------------------------------
// validateRecipe — structural sanity only, never musical judgement
// ---------------------------------------------------------------------

export const RATE_MIN = 0.5;
export const RATE_MAX = 2;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function checkCurve(
  errors: string[],
  name: string,
  curve: KeyframedCurve | undefined,
): void {
  if (!Array.isArray(curve)) {
    errors.push(`curves.${name}: missing or not a point list`);
    return;
  }
  let prevBeat = -Infinity;
  curve.forEach((point, i) => {
    if (
      !point ||
      !isFiniteNumber(point.atBeat) ||
      !isFiniteNumber(point.value)
    ) {
      errors.push(`curves.${name}[${i}]: point needs finite atBeat and value`);
      return;
    }
    if (point.atBeat < prevBeat) {
      errors.push(`curves.${name}[${i}]: points out of order by atBeat`);
    }
    prevBeat = point.atBeat;
    if (
      point.easing !== undefined &&
      point.easing !== "linear" &&
      point.easing !== "step"
    ) {
      errors.push(`curves.${name}[${i}]: unknown easing`);
    }
  });
}

function checkSpanWithinTrack(
  errors: string[],
  label: string,
  startMs: number,
  endMs: number,
  durationMs: number | null,
): void {
  if (durationMs !== null && endMs > durationMs) {
    errors.push(`${label}: span ends past the track's known duration`);
  }
}

/**
 * Structural validation of a recipe against the two tracks' facts.
 * Returns a list of human-readable structural errors; an empty list
 * means the recipe is well-formed. Checks: required fields present,
 * family/technique/kind vocabularies, finite numbers everywhere,
 * curve points ordered, anchors finite, >= 0 and inside the tracks'
 * durations when those are known, loop/scratch spans ordered and
 * inside their side's known duration, block beat spans positive,
 * sustained rates within [0.5, 2], evidence values finite.
 *
 * Deliberately NOT checked (musical judgement, out of scope here):
 * key compatibility, vocal overlap, overlap length taste, curve
 * value ranges, whether the family "suits" the pair.
 */
export function validateRecipe(
  recipe: JoinRecipe,
  factsA: TrackFacts,
  factsB: TrackFacts,
): string[] {
  const errors: string[] = [];
  if (!recipe || typeof recipe !== "object") {
    return ["recipe: not an object"];
  }
  if (typeof recipe.id !== "string" || recipe.id.length === 0) {
    errors.push("id: missing or empty");
  }
  if (!JOIN_FAMILIES.includes(recipe.family)) {
    errors.push(`family: unknown join family ${String(recipe.family)}`);
  }
  if (
    recipe.technique !== undefined &&
    !SCRATCH_TECHNIQUES.includes(recipe.technique)
  ) {
    errors.push(
      `technique: unknown scratch technique ${String(recipe.technique)}`,
    );
  }

  // Anchors.
  const out = recipe.outgoing;
  const inc = recipe.incoming;
  if (!out || typeof out.trackId !== "string" || out.trackId.length === 0) {
    errors.push("outgoing.trackId: missing or empty");
  }
  if (!inc || typeof inc.trackId !== "string" || inc.trackId.length === 0) {
    errors.push("incoming.trackId: missing or empty");
  }
  if (out) {
    if (!isFiniteNumber(out.exitAnchorMs) || out.exitAnchorMs < 0) {
      errors.push("outgoing.exitAnchorMs: must be a finite number >= 0");
    } else if (
      factsA?.durationMs !== null &&
      factsA?.durationMs !== undefined &&
      out.exitAnchorMs > factsA.durationMs
    ) {
      errors.push("outgoing.exitAnchorMs: past the outgoing track's duration");
    }
    if (!isFiniteNumber(out.exitBeat) || out.exitBeat < 0) {
      errors.push("outgoing.exitBeat: must be a finite number >= 0");
    }
  }
  if (inc) {
    if (!isFiniteNumber(inc.entryAnchorMs) || inc.entryAnchorMs < 0) {
      errors.push("incoming.entryAnchorMs: must be a finite number >= 0");
    } else if (
      factsB?.durationMs !== null &&
      factsB?.durationMs !== undefined &&
      inc.entryAnchorMs > factsB.durationMs
    ) {
      errors.push("incoming.entryAnchorMs: past the incoming track's duration");
    }
    if (!isFiniteNumber(inc.entryBeat) || inc.entryBeat < 0) {
      errors.push("incoming.entryBeat: must be a finite number >= 0");
    }
  }

  if (!isFiniteNumber(recipe.overlapBeats) || recipe.overlapBeats < 0) {
    errors.push("overlapBeats: must be a finite number >= 0");
  }

  // Sustained rates.
  const rates = recipe.rates;
  if (!rates) {
    errors.push("rates: missing");
  } else {
    for (const [name, value] of [
      ["rateA", rates.rateA],
      ["rateB", rates.rateB],
    ] as const) {
      if (!isFiniteNumber(value) || value < RATE_MIN || value > RATE_MAX) {
        errors.push(`rates.${name}: must be within [${RATE_MIN}, ${RATE_MAX}]`);
      }
    }
    if (typeof rates.beatmatched !== "boolean") {
      errors.push("rates.beatmatched: must be a boolean");
    }
  }

  // Curves.
  const curves = recipe.curves;
  if (!curves) {
    errors.push("curves: missing");
  } else {
    checkCurve(errors, "gainA", curves.gainA);
    checkCurve(errors, "gainB", curves.gainB);
    checkCurve(errors, "filterA", curves.filterA);
    checkCurve(errors, "filterB", curves.filterB);
    for (const side of ["eqA", "eqB"] as const) {
      const eq = curves[side];
      if (!eq) {
        errors.push(`curves.${side}: missing`);
        continue;
      }
      checkCurve(errors, `${side}.low`, eq.low);
      checkCurve(errors, `${side}.mid`, eq.mid);
      checkCurve(errors, `${side}.high`, eq.high);
    }
  }

  // Blocks.
  if (!Array.isArray(recipe.blocks)) {
    errors.push("blocks: missing or not a list");
  } else {
    recipe.blocks.forEach((block, i) => {
      const label = `blocks[${i}]`;
      if (!block || typeof block !== "object") {
        errors.push(`${label}: not an object`);
        return;
      }
      const durationFor = (side: RecipeSide): number | null =>
        side === "A"
          ? (factsA?.durationMs ?? null)
          : (factsB?.durationMs ?? null);
      switch (block.type) {
        case "loop": {
          if (block.side !== "A" && block.side !== "B") {
            errors.push(`${label}: loop side must be "A" or "B"`);
          }
          if (
            !isFiniteNumber(block.startMs) ||
            !isFiniteNumber(block.endMs) ||
            block.startMs < 0 ||
            block.endMs <= block.startMs
          ) {
            errors.push(`${label}: loop span must be finite and ordered`);
          } else if (block.side === "A" || block.side === "B") {
            checkSpanWithinTrack(
              errors,
              label,
              block.startMs,
              block.endMs,
              durationFor(block.side),
            );
          }
          if (!Number.isInteger(block.wraps) || block.wraps < 1) {
            errors.push(`${label}: loop wraps must be an integer >= 1`);
          }
          break;
        }
        case "jog": {
          if (block.side !== "A" && block.side !== "B") {
            errors.push(`${label}: jog side must be "A" or "B"`);
          }
          if (!JOG_KINDS.includes(block.kind)) {
            errors.push(`${label}: unknown jog kind ${String(block.kind)}`);
          }
          if (!isFiniteNumber(block.atBeat) || block.atBeat < 0) {
            errors.push(`${label}: jog atBeat must be a finite number >= 0`);
          }
          if (!isFiniteNumber(block.beats) || block.beats <= 0) {
            errors.push(`${label}: jog beats must be a finite number > 0`);
          }
          if (block.bend !== undefined && !isFiniteNumber(block.bend)) {
            errors.push(`${label}: jog bend must be finite when present`);
          }
          if (block.peakRate !== undefined && !isFiniteNumber(block.peakRate)) {
            errors.push(`${label}: jog peakRate must be finite when present`);
          }
          break;
        }
        case "scratch": {
          if (block.side !== "A" && block.side !== "B") {
            errors.push(`${label}: scratch side must be "A" or "B"`);
          }
          if (!SCRATCH_TECHNIQUES.includes(block.technique)) {
            errors.push(
              `${label}: unknown scratch technique ${String(block.technique)}`,
            );
          }
          if (!isFiniteNumber(block.atBeat) || block.atBeat < 0) {
            errors.push(
              `${label}: scratch atBeat must be a finite number >= 0`,
            );
          }
          if (!isFiniteNumber(block.beats) || block.beats <= 0) {
            errors.push(`${label}: scratch beats must be a finite number > 0`);
          }
          if (
            !isFiniteNumber(block.windowStartMs) ||
            !isFiniteNumber(block.windowEndMs) ||
            block.windowStartMs < 0 ||
            block.windowEndMs <= block.windowStartMs
          ) {
            errors.push(`${label}: scratch window must be finite and ordered`);
          } else if (block.side === "A" || block.side === "B") {
            checkSpanWithinTrack(
              errors,
              label,
              block.windowStartMs,
              block.windowEndMs,
              durationFor(block.side),
            );
          }
          break;
        }
        case "fx": {
          if (
            block.side !== "A" &&
            block.side !== "B" &&
            block.side !== "tail"
          ) {
            errors.push(`${label}: fx side must be "A", "B" or "tail"`);
          }
          if (!FX_KINDS.includes(block.kind)) {
            errors.push(`${label}: unknown fx kind ${String(block.kind)}`);
          }
          if (!isFiniteNumber(block.atBeat) || block.atBeat < 0) {
            errors.push(`${label}: fx atBeat must be a finite number >= 0`);
          }
          if (!isFiniteNumber(block.beats) || block.beats <= 0) {
            errors.push(`${label}: fx beats must be a finite number > 0`);
          }
          if (!block.params || typeof block.params !== "object") {
            errors.push(`${label}: fx params must be an object`);
          } else {
            for (const [key, value] of Object.entries(block.params)) {
              if (!isFiniteNumber(value)) {
                errors.push(`${label}: fx param ${key} must be finite`);
              }
            }
          }
          break;
        }
        default:
          errors.push(
            `${label}: unknown block type ${String((block as { type: unknown }).type)}`,
          );
      }
    });
  }

  // Authorship record.
  if (!recipe.authored || typeof recipe.authored !== "object") {
    errors.push("authored: missing");
  } else {
    if (
      !recipe.authored.evidence ||
      typeof recipe.authored.evidence !== "object"
    ) {
      errors.push("authored.evidence: must be an object");
    } else {
      for (const [key, value] of Object.entries(recipe.authored.evidence)) {
        if (!isFiniteNumber(value)) {
          errors.push(`authored.evidence.${key}: must be a finite number`);
        }
      }
    }
    if (
      !Array.isArray(recipe.authored.notes) ||
      recipe.authored.notes.some((n) => typeof n !== "string")
    ) {
      errors.push("authored.notes: must be a list of strings");
    }
  }

  return errors;
}
