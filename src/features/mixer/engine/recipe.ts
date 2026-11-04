import type { TransitionPlan } from "./transitionPlanner";

// The transition recipe: a complete, self-describing written plan for
// joining ONE ordered pair of tracks — the outgoing A and the incoming
// B. It mirrors the shape Spotify's Automix machinery proved at scale
// (the REA study, rea-study/FINDINGS.md): per-pair geometry (two
// anchors and a duration, in milliseconds AND bars), per-side playback
// rates and tempos, a beatmatched flag, a preset family, and full
// automation curves — point lists with easings — for volume, 3-band
// EQ, filter and FX, plus loop blocks. Where Spotify's recipes are
// invalidated by a beats-hash, ours carry the two analyses'
// fingerprints for the same reason.
//
// A recipe is DATA — plain JSON-shaped values, no functions, no audio
// nodes. It can be printed, logged, diffed, stored and tested without
// a sound card. Authoring (transitionPlanner.authorRecipe) is policy;
// performing (twoDeckMixer.performRecipe) is mechanism; this module
// is only the shared language between them, plus validation and the
// adapter that re-expresses a legacy TransitionPlan as a recipe so
// the current session's blends are performed by the same executor.
//
// This module holds no policy and performs nothing.

/** The preset families, in the REA vocabulary (plus our plain fade/cut). */
export type RecipePreset =
  "beatmatched-fade" | "beatmatched-cut" | "fade" | "cut";

export type CurveKind =
  "linear-gain" | "eq-gain" | "filter-cutoff" | "dry-wet" | "rate";

export type CurveUnit = "linear" | "decibels" | "hertz" | "percent" | "ratio";

export type CurveEasing = "linear" | "power-in" | "power-out" | "smooth";

/**
 * One automation knot. Times are milliseconds from the start of the
 * overlap (points past the overlap's end are legal — the incoming
 * deck's rate return lives there). `easing` describes the segment
 * FROM this point to the next; the last point's easing is ignored.
 */
export interface AutomationPoint {
  atMs: number;
  value: number;
  easing?: CurveEasing;
}

export interface AutomationCurve {
  kind: CurveKind;
  unit: CurveUnit;
  points: AutomationPoint[];
}

export interface EqCurves {
  low: AutomationCurve;
  mid: AutomationCurve;
  high: AutomationCurve;
}

export interface RecipeOverlap {
  /**
   * Track time in A where the overlap begins, in milliseconds — or
   * null when the recipe was adapted from a legacy plan, whose
   * geometry is relative ("wherever A is when the overlap begins");
   * the session's own scheduling owns A's position in that case. The
   * executor never starts deck A (it is already playing); this anchor
   * is the artefact's record of intent, and what the vocal referee
   * needs to re-inspect the window.
   */
  startAMs: number | null;
  /** Track time in B where the overlap begins, in milliseconds. */
  startBMs: number;
  /** Length of the overlap in milliseconds (0 for a hard cut). */
  durationMs: number;
  /** Length of the overlap in bars of A (display/metadata). */
  durationBars: number;
  /** Whether the overlap is tempo-aligned (rates differ to match). */
  beatmatched: boolean;
  /** Playback rate of A during the overlap (our author keeps it 1). */
  rateA: number;
  /** Playback rate of B during the overlap. */
  rateB: number;
  /**
   * The pitch-preserving rendition factor for B, when this join is
   * performed against a pre-rendered time-stretched copy of B (the
   * stretch integration): the rendition already plays at A's tempo,
   * so the deck runs it at rate 1, the rateB automation is flat, and
   * there is NO rate return — the old glide back is abolished in
   * this mode. Null = ordinary performance against B's original
   * buffer, where the rateB automation does the tempo work (or the
   * join is rate-1). The value equals rateB when set. Every anchor
   * in this recipe stays in B's ORIGINAL track time in both modes;
   * the executor converts B-side buffer positions by this factor at
   * the reads that touch the buffer.
   */
  stretchB: number | null;
  bpmA: number;
  bpmB: number;
}

export type RecipeLoopType =
  "loop" | "spinback" | "vinyl-stop" | "brake" | "nudge" | "scratch";

/**
 * The scratch techniques (spec §2B), in the order a DJ learns them:
 * the baby is the foundation hand motion with the fader open; the
 * chirp, transformer and flare are FADER work layered over the hand
 * — the gate chops what the hand moves. (Backspin, brake and vinyl
 * stop are the same table's other rows; they are jog moves, above.)
 */
export type ScratchTechnique =
  "baby" | "chirp" | "transformer" | "flare" | "crab";

/**
 * A block of performed motion on one deck: a loop region, or — since
 * the liveRave revamp's R1 — a JOG MOVE. The jog moves are the
 * virtual REV7's foundation vocabulary (spec §2B): the deck's
 * playback rate (and, for a spinback, its direction) is driven as
 * written, at a moment the recipe names.
 *
 * Timing semantics differ by kind, and the executor honours them
 * exactly:
 *
 * - `loop`: [startMs, endMs] is a region of the side's track time;
 *   playback repeats it. `beats` is the region's length in beats.
 * - `vinyl-stop` / `brake` (the stop family): the deck's rate falls
 *   from its playing rate to silence, beginning at startMs (the
 *   side's track time) and lasting `beats` beats of that side's
 *   tempo. A vinyl stop falls fast — most of the pitch drop lands
 *   early, like a hand killing a record; a brake falls gradually
 *   over the whole span, like a turntable spinning down. The two
 *   are one scored family ("vinyl-stop"); the block names the
 *   technique. [startMs, endMs] is the nominal window (startMs +
 *   beats), recorded for the audit trail — a stopping deck does not
 *   actually traverse it.
 * - `spinback`: the deck's rate drives NEGATIVE to `peakRate`,
 *   beginning at startMs and lasting `beats` beats — the track
 *   audibly runs backwards, faster and faster, then the deck stops.
 * - `nudge`: a temporary rate bend that RETURNS — the deck's rate
 *   multiplies by `bend` at the move's midpoint and is back to its
 *   written rate by the move's end. The beat-alignment primitive: a
 *   push (bend > 1) or a pull (bend < 1), never a new tempo.
 * - `scratch` (the revamp's R2): POSITION manipulation. Over the
 *   window [startMs, startMs + beats] of the side's track time the
 *   deck's rate is driven as a HAND MOTION — `strokes` forward
 *   strokes, each sweeping `excursionBeats` of audio, each followed
 *   by a return stroke — while the deck's scratch gate plays the
 *   technique's fader pattern (baby: gate open throughout; chirp:
 *   gate closed on the forward stroke, open on the return;
 *   transformer: gate clicking at `clicksPerBeat` over a slow hand;
 *   flare: gate open mid-stroke, clicking shut at each extreme —
 *   the 1-click flare; crab: the gate rests CLOSED and is tapped
 *   open in finger bursts — `tapsPerStroke` brief blips across each
 *   stroke's forward drag — while the hand drags asymmetrically,
 *   a long forward pull repaid by a return three times as steep).
 *   The hand is ADVANCE-EXACT by construction:
 *   each forward stroke's excess over the written rate is repaid
 *   by its return stroke, so over the window the deck's position
 *   advances exactly as unperturbed playback would — at the
 *   window's end the rate is the written rate again, the position
 *   is the position the recipe's geometry promised, and nothing
 *   downstream (later moves, the session's position model, the
 *   track's end) needs to know a scratch happened.
 */
export interface RecipeLoopBlock {
  type: RecipeLoopType;
  side: "A" | "B";
  /** Region (loop) or start (jog move), in the side's own track time. */
  startMs: number;
  endMs: number;
  /** Length of the region/move in beats of that side. */
  beats: number;
  /** Spinback only: the negative playback rate at the spin's peak. */
  peakRate?: number;
  /** Nudge only: the rate multiplier at the bend's midpoint (≠ 1). */
  bend?: number;
  /** Scratch only: which technique the hand and gate perform. */
  technique?: ScratchTechnique;
  /**
   * Scratch only: the number of forward strokes in the window (for
   * a transformer, the number of slow hand cycles). Each forward
   * stroke is followed by its return stroke.
   */
  strokes?: number;
  /**
   * Scratch only: how much audio each stroke sweeps, in beats of
   * the side's tempo. This sets the hand's speed against the
   * written rate — an excursion wider than the stroke's own length
   * in beats drives the return stroke backwards through zero.
   */
  excursionBeats?: number;
  /** Transformer only: the gate's click rhythm, in clicks per beat. */
  clicksPerBeat?: number;
  /**
   * Crab only: the finger count of each stroke's burst — how many
   * brief gate openings the fader hand taps out across one forward
   * drag. Counted per STROKE, not per beat (that is clicksPerBeat's
   * quantity, and the two are not interchangeable): three fingers
   * or four are the technique — a two-tap burst is a twiddle, a
   * different named move this engine does not perform.
   */
  tapsPerStroke?: number;
}

export interface RecipeEcho {
  /** Delay time in seconds (the author derives it from A's tempo). */
  delaySec: number;
  /** Feedback amount 0..1 (below 1, always — tails must dissolve). */
  feedback: number;
  /** Wet level 0..1 at the shared echo return. */
  wet: number;
  /** The rhythmic division the delay was derived from, in beats. */
  divisionBeats: number;
}

/** The effect kinds a recipe can name (the revamp's R3). */
export type RecipeEffectKind =
  | "reverb"
  | "delay"
  | "flanger"
  | "phaser"
  | "distortion"
  | "spiral"
  | "trans"
  | "roll";

export interface RecipeReverbFx {
  decaySec: number;
  wet: number;
}

export interface RecipeDelayFx {
  /** Delay time in seconds — ABSOLUTE, authored from the side's tempo (the fx.echo precedent). */
  delaySec: number;
  feedback: number;
  wet: number;
}

export interface RecipeFlangerFx {
  rateHz: number;
  depthMs: number;
  feedback: number;
  wet: number;
}

export interface RecipePhaserFx {
  rateHz: number;
  depth: number;
  wet: number;
}

export interface RecipeDistortionFx {
  amount: number;
  wet: number;
}

export interface RecipeSpiralFx {
  delaySec: number;
  sweepToRatio: number;
  feedback: number;
  wet: number;
}

export interface RecipeTransFx {
  divisionBeats: number;
  depth: number;
}

export interface RecipeRollFx {
  sliceBeats: number;
  feedback: number;
}

export interface RecipeFx {
  echo?: RecipeEcho;
  reverb?: RecipeReverbFx;
  delay?: RecipeDelayFx;
  flanger?: RecipeFlangerFx;
  phaser?: RecipePhaserFx;
  distortion?: RecipeDistortionFx;
  spiral?: RecipeSpiralFx;
  trans?: RecipeTransFx;
  roll?: RecipeRollFx;
  /**
   * When true, the delay network's wet return also feeds the
   * reverb input (the cascade) — delay into reverb, the classic
   * spacious tail. The executor sets the cascade gain at the
   * blend's start: 0.6 when this is true, 0 otherwise.
   */
  chainDelayIntoReverb?: boolean;
}

/**
 * One performed effect window: a named effect, on one side, over a
 * window of that side's track time — the loop blocks' convention.
 * `level` is the peak send level for the send-class effects, the
 * capture send level for roll, and 1 (unused) for trans, whose
 * depth lives in its config.
 */
export interface RecipeEffectBlock {
  kind: RecipeEffectKind;
  side: "A" | "B";
  startMs: number;
  endMs: number;
  beats: number;
  level: number;
}

/**
 * What to do instead when the recipe cannot be performed as written
 * (the analyses it was authored against changed underneath it, or it
 * fails validation at the deck). S5-2's executor honours this itself:
 * a plain cut — B starts at its anchor, A stops — never a forced
 * blend. Session-level fallbacks (Step 2's plain cut at track end)
 * are a separate, coarser net and stay where they are.
 */
export interface RecipeFallback {
  kind: "cut";
  note: string;
}

/**
 * Why this recipe looks the way it does — the author's evidence,
 * recorded on the artefact so a performed join can be audited after
 * the fact (and so the ear-test pattern log has something to read).
 */
export interface RecipeEvidence {
  entryReason: string;
  exitReason: string;
  /**
   * Graded vocal-overlap integral over the performed window, 0..1 —
   * the integrated product of both sides' confidence-weighted vocal
   * activity. 0 = at most one voice; 1 = both voices at full activity
   * throughout. (Legacy-plan recipes carry the old boolean as 0/1 —
   * coarse, and labelled so by `vocalEvidence` being "trusted" only
   * in the sense that the boolean was all v1 ever knew.)
   */
  vocalOverlap: number;
  /**
   * "trusted" when the vocal reading behind the recipe carried real
   * confidence on both sides; "uncertain" when either side's evidence
   * was weak over the window — in which case the referee shortened at
   * most one step and did NOT force a family change on that evidence
   * alone (a monophonic synth lead can read as voice; see the S5-1
   * report §3).
   */
  vocalEvidence: "trusted" | "uncertain";
  /** |rateB − 1| for the pair. */
  tempoStretch: number;
  /** Camelot fit score 0..1 when both keys are known, else null. */
  keyScore: number | null;
  /** True when the vocal referee shortened this recipe's overlap. */
  refereeShortened: boolean;
}

export interface TransitionRecipe {
  version: 1;
  preset: RecipePreset;
  overlap: RecipeOverlap;
  /**
   * Seconds from the moment performance is requested until the
   * overlap begins — the author's scheduling lead (exit time minus
   * the position it authored from; a legacy plan's startsInSec).
   */
  leadInSec: number;
  automation: {
    volumeOut: AutomationCurve;
    volumeIn: AutomationCurve;
    eqOut: EqCurves;
    eqIn: EqCurves;
    filterOut: AutomationCurve;
    filterIn: AutomationCurve;
    /**
     * Playback-rate automation for deck B, in overlap-relative
     * milliseconds. Spans the overlap AND the rate return after it:
     * the return's length is recipe data, chosen from the incoming
     * track's structure — never a fixed phrase.
     */
    rateB: AutomationCurve;
    /** Echo send levels 0..1 for each deck (normally only A moves). */
    echoSendOut: AutomationCurve;
    echoSendIn: AutomationCurve;
  };
  loops: RecipeLoopBlock[];
  fx: RecipeFx;
  /**
   * Performed effect windows (the revamp's R3). OPTIONAL on
   * purpose — the R1/R2 optional-field precedent: new vocabulary
   * must not churn every recipe constructor or test literal in
   * the tree. Everywhere it is read: `recipe.effects ?? []`.
   */
  effects?: RecipeEffectBlock[];
  /** The analyses this recipe was authored against (REA's beats-hash lesson). */
  fingerprints: {
    aAudioHash: string | null;
    bAudioHash: string | null;
    analysisVersion: number | null;
  };
  fallback: RecipeFallback;
  evidence: RecipeEvidence;
}

/** The lowpass frequency that means "filter open" in a recipe. */
export const OPEN_FILTER_HZ = 20_000;
/** Full bass cut, in dB — matches deck.ts's BASS_CUT_DB. */
export const FULL_BASS_CUT_DB = -32;

const VALUE_RANGES: Record<CurveKind, [number, number]> = {
  "linear-gain": [0, 1.5],
  "eq-gain": [-48, 12],
  "filter-cutoff": [20, 20_000],
  "dry-wet": [0, 1],
  rate: [0.5, 2],
};

function checkCurve(
  errors: string[],
  name: string,
  curve: AutomationCurve,
): void {
  if (curve.points.length === 0) {
    errors.push(`${name}: curve has no points`);
    return;
  }
  const [min, max] = VALUE_RANGES[curve.kind];
  let previousAt = -Infinity;
  for (const point of curve.points) {
    if (!Number.isFinite(point.atMs) || point.atMs < 0) {
      errors.push(`${name}: point time ${point.atMs} is not a valid time`);
    }
    if (point.atMs < previousAt) {
      errors.push(`${name}: points are not in ascending time order`);
    }
    previousAt = point.atMs;
    if (
      !Number.isFinite(point.value) ||
      point.value < min ||
      point.value > max
    ) {
      errors.push(
        `${name}: value ${point.value} outside ${curve.kind} range [${min}, ${max}]`,
      );
    }
  }
}

/**
 * Structural validation — returns every problem found (empty array =
 * performable). The executor refuses recipes with errors and performs
 * the fallback instead; the author is expected to emit none.
 */
export function validateRecipe(recipe: TransitionRecipe): string[] {
  const errors: string[] = [];
  if (recipe.version !== 1)
    errors.push(`version ${recipe.version} unsupported`);
  const o = recipe.overlap;
  if (o.startAMs !== null && (!Number.isFinite(o.startAMs) || o.startAMs < 0)) {
    errors.push("overlap.startAMs must be null or a finite time ≥ 0");
  }
  if (!Number.isFinite(o.startBMs) || o.startBMs < 0) {
    errors.push("overlap.startBMs must be a finite time ≥ 0");
  }
  if (!Number.isFinite(o.durationMs) || o.durationMs < 0) {
    errors.push("overlap.durationMs must be ≥ 0");
  }
  if (!Number.isFinite(o.durationBars) || o.durationBars < 0) {
    errors.push("overlap.durationBars must be ≥ 0");
  }
  for (const [name, rate] of [
    ["rateA", o.rateA],
    ["rateB", o.rateB],
  ] as const) {
    if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) {
      errors.push(`overlap.${name} ${rate} outside [0.5, 2]`);
    }
  }
  if (
    o.stretchB !== null &&
    (!Number.isFinite(o.stretchB) || o.stretchB < 0.5 || o.stretchB > 2)
  ) {
    errors.push(`overlap.stretchB ${o.stretchB} outside [0.5, 2]`);
  }
  if (!(o.bpmA > 0) || !(o.bpmB > 0)) {
    errors.push("overlap bpms must be positive");
  }
  if (!Number.isFinite(recipe.leadInSec) || recipe.leadInSec < 0) {
    errors.push("leadInSec must be ≥ 0");
  }
  const a = recipe.automation;
  checkCurve(errors, "volumeOut", a.volumeOut);
  checkCurve(errors, "volumeIn", a.volumeIn);
  for (const side of ["eqOut", "eqIn"] as const) {
    checkCurve(errors, `${side}.low`, a[side].low);
    checkCurve(errors, `${side}.mid`, a[side].mid);
    checkCurve(errors, `${side}.high`, a[side].high);
  }
  checkCurve(errors, "filterOut", a.filterOut);
  checkCurve(errors, "filterIn", a.filterIn);
  checkCurve(errors, "rateB", a.rateB);
  checkCurve(errors, "echoSendOut", a.echoSendOut);
  checkCurve(errors, "echoSendIn", a.echoSendIn);
  for (const loop of recipe.loops) {
    if (loop.endMs <= loop.startMs) {
      errors.push(`loop on ${loop.side}: endMs must exceed startMs`);
    }
    if (!(loop.beats > 0))
      errors.push(`loop on ${loop.side}: beats must be > 0`);
    if (loop.type === "spinback") {
      // A spinback without its negative peak is not a spinback —
      // and a peak outside the sane band is not a record spinning
      // back, it's damage.
      if (
        loop.peakRate === undefined ||
        !Number.isFinite(loop.peakRate) ||
        loop.peakRate < -6 ||
        loop.peakRate > -1
      ) {
        errors.push(
          `spinback on ${loop.side}: peakRate ${loop.peakRate} outside [-6, -1]`,
        );
      }
    }
    if (loop.type === "nudge") {
      // A nudge is a bend that returns, not a tempo change: its
      // multiplier hugs 1, and a multiplier OF 1 is no move at all.
      if (
        loop.bend === undefined ||
        !Number.isFinite(loop.bend) ||
        loop.bend < 0.9 ||
        loop.bend > 1.1 ||
        loop.bend === 1
      ) {
        errors.push(
          `nudge on ${loop.side}: bend ${loop.bend} outside [0.9, 1.1] or equal to 1`,
        );
      }
    }
    if (loop.type === "scratch") {
      // A scratch is a named technique, a counted set of strokes,
      // and a stated sweep. Without the technique there is no fader
      // pattern to perform; without strokes there is no hand motion
      // at all (a chirp with no direction change, a flare with no
      // strokes, is not a quieter scratch — it is not the move); a
      // sweep of zero is a hand resting on the record, and a sweep
      // past two beats per stroke is a hand throwing it.
      if (
        loop.technique !== "baby" &&
        loop.technique !== "chirp" &&
        loop.technique !== "transformer" &&
        loop.technique !== "flare" &&
        loop.technique !== "crab"
      ) {
        errors.push(
          `scratch on ${loop.side}: technique ${loop.technique} is not a scratch technique`,
        );
      }
      if (
        loop.strokes === undefined ||
        !Number.isInteger(loop.strokes) ||
        loop.strokes < 1
      ) {
        errors.push(
          `scratch on ${loop.side}: strokes ${loop.strokes} is not a whole number ≥ 1`,
        );
      }
      if (
        loop.excursionBeats === undefined ||
        !Number.isFinite(loop.excursionBeats) ||
        loop.excursionBeats <= 0 ||
        loop.excursionBeats > 2
      ) {
        errors.push(
          `scratch on ${loop.side}: excursionBeats ${loop.excursionBeats} outside (0, 2]`,
        );
      }
      if (!(loop.beats >= 1)) {
        errors.push(
          `scratch on ${loop.side}: a window of ${loop.beats} beats has no room for a stroke pair`,
        );
      }
      if (loop.technique === "transformer") {
        // The transformer's rhythm IS its fader pattern: a
        // transformer without a stated click rhythm cannot be
        // performed, and a rhythm past 8 clicks per beat is a
        // tremolo, not a fader technique.
        if (
          loop.clicksPerBeat === undefined ||
          !Number.isFinite(loop.clicksPerBeat) ||
          loop.clicksPerBeat <= 0 ||
          loop.clicksPerBeat > 8
        ) {
          errors.push(
            `transformer on ${loop.side}: clicksPerBeat ${loop.clicksPerBeat} outside (0, 8]`,
          );
        }
      }
      if (
        loop.tapsPerStroke !== undefined &&
        (!Number.isInteger(loop.tapsPerStroke) ||
          loop.tapsPerStroke < 3 ||
          loop.tapsPerStroke > 4)
      ) {
        // A tap count is a finger count: whole, and inside the
        // hand's honest range wherever the field appears — the
        // clicksPerBeat precedent, range-checked wherever present.
        errors.push(
          `scratch on ${loop.side}: tapsPerStroke ${loop.tapsPerStroke} outside [3, 4]`,
        );
      }
      if (loop.technique === "crab" && loop.tapsPerStroke === undefined) {
        // The taps ARE the crab: a crab without its finger count
        // has no fader pattern to perform.
        errors.push(
          `crab on ${loop.side}: tapsPerStroke is required — the taps are the technique`,
        );
      }
    }
  }
  if (recipe.fx.echo) {
    const e = recipe.fx.echo;
    if (!(e.delaySec > 0) || e.delaySec > 2) {
      errors.push("fx.echo.delaySec outside (0, 2]");
    }
    if (e.feedback < 0 || e.feedback >= 0.9) {
      errors.push("fx.echo.feedback outside [0, 0.9)");
    }
    if (e.wet < 0 || e.wet > 1) errors.push("fx.echo.wet outside [0, 1]");
  }
  if (recipe.fx.reverb) {
    const c = recipe.fx.reverb;
    if (!(c.decaySec > 0) || c.decaySec > 8) {
      errors.push("fx.reverb.decaySec outside (0, 8]");
    }
    if (c.wet < 0 || c.wet > 1) errors.push("fx.reverb.wet outside [0, 1]");
  }
  if (recipe.fx.delay) {
    const c = recipe.fx.delay;
    if (!(c.delaySec > 0) || c.delaySec > 2) {
      errors.push("fx.delay.delaySec outside (0, 2]");
    }
    if (c.feedback < 0 || c.feedback >= 0.9) {
      errors.push("fx.delay.feedback outside [0, 0.9)");
    }
    if (c.wet < 0 || c.wet > 1) errors.push("fx.delay.wet outside [0, 1]");
  }
  if (recipe.fx.flanger) {
    const c = recipe.fx.flanger;
    if (!(c.rateHz > 0) || c.rateHz > 10) {
      errors.push("fx.flanger.rateHz outside (0, 10]");
    }
    if (!(c.depthMs > 0) || c.depthMs > 5) {
      errors.push("fx.flanger.depthMs outside (0, 5]");
    }
    if (c.feedback < 0 || c.feedback >= 0.9) {
      errors.push("fx.flanger.feedback outside [0, 0.9)");
    }
    if (c.wet < 0 || c.wet > 1) errors.push("fx.flanger.wet outside [0, 1]");
  }
  if (recipe.fx.phaser) {
    const c = recipe.fx.phaser;
    if (!(c.rateHz > 0) || c.rateHz > 5) {
      errors.push("fx.phaser.rateHz outside (0, 5]");
    }
    if (c.depth < 0 || c.depth > 1) {
      errors.push("fx.phaser.depth outside [0, 1]");
    }
    if (c.wet < 0 || c.wet > 1) errors.push("fx.phaser.wet outside [0, 1]");
  }
  if (recipe.fx.distortion) {
    const c = recipe.fx.distortion;
    if (c.amount < 0 || c.amount > 1) {
      errors.push("fx.distortion.amount outside [0, 1]");
    }
    if (c.wet < 0 || c.wet > 1) {
      errors.push("fx.distortion.wet outside [0, 1]");
    }
  }
  if (recipe.fx.spiral) {
    const c = recipe.fx.spiral;
    if (!(c.delaySec > 0) || c.delaySec > 2) {
      errors.push("fx.spiral.delaySec outside (0, 2]");
    }
    if (c.sweepToRatio < 0.2 || c.sweepToRatio > 0.95) {
      errors.push("fx.spiral.sweepToRatio outside [0.2, 0.95]");
    }
    if (c.feedback < 0 || c.feedback >= 0.9) {
      errors.push("fx.spiral.feedback outside [0, 0.9)");
    }
    if (c.wet < 0 || c.wet > 1) errors.push("fx.spiral.wet outside [0, 1]");
  }
  if (recipe.fx.trans) {
    const c = recipe.fx.trans;
    if (c.divisionBeats < 0.25 || c.divisionBeats > 2) {
      errors.push("fx.trans.divisionBeats outside [0.25, 2]");
    }
    if (!(c.depth > 0) || c.depth > 1) {
      errors.push("fx.trans.depth outside (0, 1]");
    }
  }
  if (recipe.fx.roll) {
    const c = recipe.fx.roll;
    if (c.sliceBeats < 0.25 || c.sliceBeats > 2) {
      errors.push("fx.roll.sliceBeats outside [0.25, 2]");
    }
    if (c.feedback < 0.8 || c.feedback > 0.99) {
      errors.push("fx.roll.feedback outside [0.8, 0.99]");
    }
  }
  {
    const blocks = recipe.effects ?? [];
    const kinds: RecipeEffectKind[] = [
      "reverb",
      "delay",
      "flanger",
      "phaser",
      "distortion",
      "spiral",
      "trans",
      "roll",
    ];
    let rollCount = 0;
    let spiralCount = 0;
    for (const block of blocks) {
      if (!kinds.includes(block.kind)) {
        errors.push(
          `effect block: kind ${block.kind} is not a known effect kind`,
        );
        continue;
      }
      if (block.kind === "roll") rollCount += 1;
      if (block.kind === "spiral") spiralCount += 1;
      if (!(block.endMs > block.startMs)) {
        errors.push(
          `effect ${block.kind} on ${block.side}: endMs must exceed startMs`,
        );
      }
      if (!(block.beats > 0)) {
        errors.push(`effect ${block.kind} on ${block.side}: beats must be > 0`);
      }
      if (block.level < 0 || block.level > 1) {
        errors.push(
          `effect ${block.kind} on ${block.side}: level ${block.level} outside [0, 1]`,
        );
      }
      // An orphan block is unperformable: the block names WHEN,
      // the fx config names HOW (its network tuning). Without
      // the config there is nothing honest to perform.
      if (!recipe.fx[block.kind]) {
        errors.push(
          `effect ${block.kind} on ${block.side}: no fx.${block.kind} config for this block`,
        );
      }
    }
    // Roll and spiral each own shared network parameters (the
    // roll's delay time and feedback, the spiral's sweeping
    // delay) — two of either in one recipe would fight over one
    // network, so the recipe may carry at most one of each.
    if (rollCount > 1) {
      errors.push("at most one roll block per recipe");
    }
    if (spiralCount > 1) {
      errors.push("at most one spiral block per recipe");
    }
    for (let i = 0; i < blocks.length; i += 1) {
      for (let j = i + 1; j < blocks.length; j += 1) {
        const x = blocks[i];
        const y = blocks[j];
        if (x.kind !== y.kind || x.side !== y.side) continue;
        if (x.startMs < y.endMs && y.startMs < x.endMs) {
          errors.push(`effect ${x.kind} on ${x.side}: blocks overlap in time`);
        }
      }
    }
  }
  return errors;
}

/** A flat curve at one value — the honest way to say "this never moves". */
export function flatCurve(
  kind: CurveKind,
  unit: CurveUnit,
  value: number,
): AutomationCurve {
  return { kind, unit, points: [{ atMs: 0, value }] };
}

function applyEasing(easing: CurveEasing, t: number): number {
  switch (easing) {
    case "power-in":
      return t * t;
    case "power-out":
      return 1 - (1 - t) * (1 - t);
    case "smooth":
      return t * t * (3 - 2 * t);
    default:
      return t;
  }
}

/**
 * The value a curve takes at a moment: piecewise between knots, each
 * segment shaped by the easing declared on the point it LEAVES (the
 * convention documented on AutomationPoint), with step semantics at
 * duplicated times (the last point at an atMs wins). Pure — the
 * executor samples curves through here, and tests assert performed
 * automation against it.
 */
export function automationValueAt(
  curve: AutomationCurve,
  atMs: number,
): number {
  const points = curve.points;
  if (points.length === 0) return 0;
  if (atMs < points[0].atMs) return points[0].value;
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (atMs === point.atMs) {
      let value = point.value;
      for (
        let j = i + 1;
        j < points.length && points[j].atMs === atMs;
        j += 1
      ) {
        value = points[j].value;
      }
      return value;
    }
    if (atMs < point.atMs) {
      const prev = points[i - 1];
      const span = point.atMs - prev.atMs;
      if (span <= 0) return point.value;
      const t = (atMs - prev.atMs) / span;
      return (
        prev.value +
        (point.value - prev.value) * applyEasing(prev.easing ?? "linear", t)
      );
    }
  }
  return points[points.length - 1].value;
}

function gainCurve(points: [number, number][]): AutomationCurve {
  return {
    kind: "linear-gain",
    unit: "linear",
    points: points.map(([atMs, value]) => ({ atMs, value })),
  };
}

function eqCurve(points: [number, number][]): AutomationCurve {
  return {
    kind: "eq-gain",
    unit: "decibels",
    points: points.map(([atMs, value]) => ({ atMs, value })),
  };
}

/**
 * Re-expresses a legacy TransitionPlan as a recipe, reproducing the
 * automation the v1 executor performed for it: equal-power volume
 * curves, one bass swap at the plan's swap point, the incoming rate
 * held across the blend and returned over the plan's return duration.
 * The current session's blends flow through this adapter into the
 * recipe executor, so v1 behaviour can be A/B-compared against
 * authored recipes on identical fixtures — and so there is exactly
 * one code path that ever touches the decks.
 */
export function recipeFromPlan(
  plan: TransitionPlan,
  options: { beatsPerBarA?: number } = {},
): TransitionRecipe {
  const beatsPerBar = options.beatsPerBarA ?? 4;
  const durationMs = Math.max(0, plan.blendDurationSec * 1000);
  const swapMs = Math.max(0, (plan.bassSwapInSec - plan.startsInSec) * 1000);
  const spbOut =
    plan.blendBeats > 0 ? plan.blendDurationSec / plan.blendBeats : 0.5;
  const bpmA = spbOut > 0 ? 60 / spbOut : 120;
  const bpmB = plan.incomingRate !== 0 ? bpmA / plan.incomingRate : bpmA;

  // Equal-power shapes, sampled at knots the executor's curve sampler
  // reproduces faithfully.
  const outPoints: [number, number][] = [];
  const inPoints: [number, number][] = [];
  const KNOTS = 8;
  for (let i = 0; i <= KNOTS; i += 1) {
    const t = i / KNOTS;
    outPoints.push([t * durationMs, Math.cos((t * Math.PI) / 2)]);
    inPoints.push([t * durationMs, Math.sin((t * Math.PI) / 2)]);
  }

  const ratePoints: AutomationPoint[] =
    plan.incomingRate === 1
      ? [{ atMs: 0, value: 1 }]
      : [
          { atMs: 0, value: plan.incomingRate },
          { atMs: durationMs, value: plan.incomingRate, easing: "linear" },
          {
            atMs: durationMs + plan.rateReturnDurationSec * 1000,
            value: 1,
          },
        ];

  return {
    version: 1,
    preset: "beatmatched-fade",
    overlap: {
      startAMs: null,
      startBMs: plan.incomingStartSec * 1000,
      durationMs,
      durationBars: plan.blendBeats / beatsPerBar,
      beatmatched: true,
      rateA: 1,
      rateB: plan.incomingRate,
      stretchB: null,
      bpmA,
      bpmB,
    },
    leadInSec: plan.startsInSec,
    automation: {
      volumeOut: gainCurve(outPoints),
      volumeIn: gainCurve(inPoints),
      eqOut: {
        low: eqCurve([
          [0, 0],
          [swapMs, 0],
          [swapMs + 20, FULL_BASS_CUT_DB],
        ]),
        mid: eqCurve([[0, 0]]),
        high: eqCurve([[0, 0]]),
      },
      eqIn: {
        low: eqCurve([
          [0, FULL_BASS_CUT_DB],
          [swapMs, FULL_BASS_CUT_DB],
          [swapMs + 20, 0],
        ]),
        mid: eqCurve([[0, 0]]),
        high: eqCurve([[0, 0]]),
      },
      filterOut: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      filterIn: flatCurve("filter-cutoff", "hertz", OPEN_FILTER_HZ),
      rateB: { kind: "rate", unit: "ratio", points: ratePoints },
      echoSendOut: flatCurve("dry-wet", "percent", 0),
      echoSendIn: flatCurve("dry-wet", "percent", 0),
    },
    loops: [],
    fx: {},
    fingerprints: { aAudioHash: null, bAudioHash: null, analysisVersion: null },
    fallback: {
      kind: "cut",
      note: "Legacy plan geometry: if this recipe cannot be performed, cut plainly at the blend's start.",
    },
    evidence: {
      entryReason: "legacy TransitionPlan geometry",
      exitReason: "legacy TransitionPlan geometry",
      vocalOverlap: plan.vocalOverlap ? 1 : 0,
      vocalEvidence: "trusted",
      tempoStretch: plan.tempoStretch,
      keyScore: plan.keyCompatibility?.score ?? null,
      refereeShortened: false,
    },
  };
}
