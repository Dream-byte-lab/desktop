import type { TrackAnalysis } from "./analyseTrack";
import { BASS_CUT_DB, BASS_FLAT_DB, Deck } from "./deck";
import {
  automationValueAt,
  recipeFromPlan,
  validateRecipe,
  type AutomationCurve,
  type RecipeLoopBlock,
  type TransitionRecipe,
} from "./recipe";
import { applyVocalReferee, type TransitionPlan } from "./transitionPlanner";

// Two decks and a master volume — and, since Step 5's S5-2, a recipe
// executor. The mixer's one job is to PERFORM a TransitionRecipe on
// the real decks exactly as written: automation curves executed
// against the audio clock (volume sampled faithfully; EQ, filter,
// echo sends and the playback rate scheduled knot-by-knot), bass
// swaps as EQ automation, loops armed as written. What was decided
// is what is heard — if a join sounds wrong, the recipe (data) is
// where the fault lives, not in ephemeral scheduling code.
//
// The legacy seam is preserved: transitionTo(buffer, plan) adapts
// the plan to a recipe (recipeFromPlan) and performs it through the
// same path, so the current session's blends and authored recipes
// share exactly one executor. Deck arbitration (which deck is
// current), the manual stage (trims/crossfader/bassTrim — automation
// never writes those nodes) and loudness levelling (the caller passes
// levelGainFor's result; the deck's level node holds it) are
// untouched Step 2 contracts.
//
// Recipes are plans, not suicide pacts: at performance time the
// executor re-validates, checks the analyses' fingerprints against
// the recipe's, and re-runs the vocal referee against the analyses
// as they NOW stand (a recipe authored on a fast analysis may be
// performed against the deepened one). Any failure performs the
// recipe's fallback instead — a plain cut — rather than forcing the
// blend or throwing into the session.
//
// Jog moves (the revamp's R1) are performed here too: a recipe's
// spinback / vinyl-stop / brake / nudge blocks drive the named
// deck's playback rate as written — a stop move's rate fall, a
// spinback's run into negative rates, a nudge's bend that returns.
// A's moves anchor in A's track time against the overlap's startAMs
// (a recipe without that anchor cannot place one and falls back);
// B's track time advances at rateB from startBMs, in rate mode and
// rendition mode alike, so one formula places B's moves in both.
//
// One conversion lives here, and only here: a stretch recipe's
// anchors are written in B's ORIGINAL track time (the same timeline
// the author, the referee and the session's position model all
// read), while the rendition buffer it is performed against runs
// on rendition time (original ÷ stretchB). The B-side positions
// that touch the buffer — the deck start offset, B's loop regions,
// the fallback cut's offset — are converted by the factor at
// exactly those reads. With stretchB null, nothing converts and
// performance is byte-identical to before.

/** Samples used when a volume curve is rendered for setValueCurveAtTime. */
const VOLUME_SAMPLES = 256;
/** Samples used when B's rate curve is rendered with nudge bends folded in. */
const RATE_SAMPLES = 1024;
/**
 * The rate a stopping deck falls to: effectively silence, never
 * exactly 0 — an exponential ramp cannot target 0, and a deck at
 * 2% speed under a closed fader is a stopped record.
 */
const STOP_FLOOR_RATE = 0.02;

/** The jog moves that END a deck's motion (as opposed to a nudge, which returns). */
function isStopMove(move: RecipeLoopBlock): boolean {
  return (
    move.type === "vinyl-stop" ||
    move.type === "brake" ||
    move.type === "spinback"
  );
}

/**
 * Schedules a stop-family move on a deck's rate control, from its
 * playing rate. The three techniques are three shapes of the same
 * act — the rate leaves and does not come back:
 *
 * - vinyl-stop: an exponential fall — most of the pitch drop lands
 *   in the first half, like a hand killing a record.
 * - brake: a gradual linear fall to 30% over most of the span,
 *   then the exponential settle — a turntable spinning down.
 * - spinback: the rate drives negative to the move's peakRate
 *   within the first 15% of the span, then eases slightly — the
 *   track runs backwards, hard, until the deck stops it.
 */
function scheduleStopMove(
  param: AudioParam,
  move: RecipeLoopBlock,
  startCtx: number,
  durationSec: number,
  baseRate: number,
): void {
  param.setValueAtTime(baseRate, startCtx);
  if (move.type === "vinyl-stop") {
    param.exponentialRampToValueAtTime(STOP_FLOOR_RATE, startCtx + durationSec);
  } else if (move.type === "brake") {
    param.linearRampToValueAtTime(baseRate * 0.3, startCtx + durationSec * 0.7);
    param.exponentialRampToValueAtTime(STOP_FLOOR_RATE, startCtx + durationSec);
  } else {
    const peak = move.peakRate ?? -3;
    param.linearRampToValueAtTime(peak, startCtx + durationSec * 0.15);
    param.linearRampToValueAtTime(peak * 0.8, startCtx + durationSec);
  }
}

/**
 * Schedules a nudge: the rate bends away from its written value to
 * base × bend at the move's midpoint and RETURNS by its end. A push
 * or a pull — never a new tempo.
 */
function scheduleNudge(
  param: AudioParam,
  startCtx: number,
  durationSec: number,
  baseRate: number,
  bend: number,
): void {
  param.setValueAtTime(baseRate, startCtx);
  param.linearRampToValueAtTime(baseRate * bend, startCtx + durationSec / 2);
  param.linearRampToValueAtTime(baseRate, startCtx + durationSec);
}

interface NudgeSpan {
  startOffMs: number;
  durMs: number;
  bend: number;
}

/**
 * The combined multiplier a set of nudge spans applies at a moment:
 * each bend is a triangle over its span (0 at the edges, full at
 * the midpoint), and simultaneous bends multiply.
 */
function nudgeFactorAt(spans: NudgeSpan[], atMs: number): number {
  let factor = 1;
  for (const span of spans) {
    if (atMs <= span.startOffMs || atMs >= span.startOffMs + span.durMs)
      continue;
    const phase = (atMs - span.startOffMs) / span.durMs;
    const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    factor *= 1 + (span.bend - 1) * tri;
  }
  return factor;
}
/** Safety gap between "now" and the earliest scheduled event, in seconds. */
const SCHEDULE_AHEAD_SEC = 0.1;
/** The shared echo network's resting state (echoOutCurrent's sound). */
const ECHO_DEFAULT_FEEDBACK = 0.38;
const ECHO_DEFAULT_WET = 0.55;

/**
 * Crossfader gains for a position in -1..1. This crossfader is a lean
 * control layered over the automation, not the primary fader, so the
 * centre is transparent (both decks at full) — an untouched crossfader
 * must never change what the automatic blends sound like. Moving it
 * fades the opposite deck out along a cosine curve.
 */
export function crossfadeGains(position: number): [number, number] {
  const p = Math.min(1, Math.max(-1, position));
  const deck1 = p <= 0 ? 1 : Math.cos((p * Math.PI) / 2);
  const deck2 = p >= 0 ? 1 : Math.cos((-p * Math.PI) / 2);
  return [deck1, deck2];
}

export type DeckIndex = 0 | 1;

/**
 * The echo's delay time for a tempo: a dotted eighth note (¾ of a
 * beat) — the classic echo-out spacing — clamped to a sane range.
 */
export function echoDelaySec(bpm: number): number {
  if (bpm <= 0) return 0.3;
  return Math.min(1.2, Math.max(0.08, 0.75 * (60 / bpm)));
}

/**
 * Schedules a curve knot-by-knot: a setValueAtTime at the first knot,
 * then a ramp to each later knot (a step where two knots share a
 * time). Segment easings are approximated by the ramp between knots —
 * exact for the step/slope shapes EQ, filter, send and rate curves
 * use; the smooth shapes (volume) go through the sampler instead.
 */
function scheduleEvents(
  param: AudioParam,
  curve: AutomationCurve,
  startCtxTime: number,
): void {
  const points = curve.points;
  if (points.length === 0) return;
  param.setValueAtTime(points[0].value, startCtxTime + points[0].atMs / 1000);
  for (let i = 1; i < points.length; i += 1) {
    const t = startCtxTime + points[i].atMs / 1000;
    if (
      points[i].atMs === points[i - 1].atMs ||
      points[i].value === points[i - 1].value
    ) {
      // A step, or a hold: set the value outright (the v1 executor's
      // shape — a ramp to the same value would only blur the timing).
      param.setValueAtTime(points[i].value, t);
    } else {
      param.linearRampToValueAtTime(points[i].value, t);
    }
  }
}

/** Renders a curve into a setValueCurveAtTime call, sampled through automationValueAt. */
function scheduleSampledCurve(
  param: AudioParam,
  curve: AutomationCurve,
  startCtxTime: number,
  minSpanSec: number,
): void {
  const lastAt =
    curve.points.length > 0 ? curve.points[curve.points.length - 1].atMs : 0;
  const spanSec = Math.max(minSpanSec, lastAt / 1000, 0.01);
  const values = new Float32Array(VOLUME_SAMPLES);
  for (let i = 0; i < VOLUME_SAMPLES; i += 1) {
    values[i] = automationValueAt(
      curve,
      (i / (VOLUME_SAMPLES - 1)) * spanSec * 1000,
    );
  }
  param.setValueCurveAtTime(values, startCtxTime, spanSec);
}

export interface PerformRecipeOptions {
  /** Level-matching gain for the incoming track (levelMatch's output). */
  levelGain?: number;
  /**
   * The two analyses as they stand at performance time, when the
   * caller has them: the executor checks the recipe's fingerprints
   * against them and re-runs the vocal referee on the (possibly
   * deepened) evidence. Without them the recipe is performed as
   * written, after structural validation only.
   */
  outgoing?: TrackAnalysis;
  incoming?: TrackAnalysis;
}

export class TwoDeckMixer {
  readonly master: GainNode;
  private readonly decks: [Deck, Deck];
  private readonly trims: [GainNode, GainNode];
  private readonly echoDelay: DelayNode;
  private readonly echoFeedback: GainNode;
  private readonly echoWet: GainNode;
  private current = 0;
  private crossfadePosition = 0;
  private readonly deckTrimLevels: [number, number] = [1, 1];

  constructor(private readonly context: AudioContext) {
    this.master = context.createGain();
    this.master.gain.value = 1;
    this.master.connect(context.destination);

    // The shared echo network: a feedback delay with a low-pass in
    // the loop, so each repeat comes back darker and softer than the
    // last and the tail dissolves instead of ringing forever. Both
    // decks can send into it (post-fader); the wet signal returns
    // straight to the master, so a tail keeps sounding across a deck
    // change — which is exactly what an echo-out needs. Feedback and
    // wet are fields since S5-2: a recipe's fx.echo retunes the
    // network for its join, and echoOutCurrent restores the defaults.
    this.echoDelay = context.createDelay(2);
    this.echoDelay.delayTime.value = 0.3;
    const echoFilter = context.createBiquadFilter();
    echoFilter.type = "lowpass";
    echoFilter.frequency.value = 1200;
    this.echoFeedback = context.createGain();
    this.echoFeedback.gain.value = ECHO_DEFAULT_FEEDBACK;
    this.echoWet = context.createGain();
    this.echoWet.gain.value = ECHO_DEFAULT_WET;
    this.echoDelay.connect(echoFilter);
    echoFilter.connect(this.echoFeedback);
    this.echoFeedback.connect(this.echoDelay);
    this.echoDelay.connect(this.echoWet);
    this.echoWet.connect(this.master);

    // The manual stage: each deck runs through its own trim gain before
    // the master. The automation writes the decks' own gains; hands
    // (the Pro layer) write these trims and the crossfader. Because the
    // two multiply rather than share one control, a hand on the mixer
    // can lean on a blend but can never corrupt its scheduling.
    this.trims = [context.createGain(), context.createGain()];
    for (const trim of this.trims) trim.connect(this.master);
    this.decks = [
      new Deck(context, this.trims[0], this.echoDelay),
      new Deck(context, this.trims[1], this.echoDelay),
    ];
  }

  /**
   * Opens the current deck's echo send, beat-synced to its tempo, for
   * about a second of capture; the delay network then rings the tail
   * out over whatever plays next. The send closes itself so later
   * tracks are never echoed by accident.
   */
  echoOutCurrent(bpm: number): void {
    const now = this.context.currentTime;
    this.echoDelay.delayTime.setValueAtTime(echoDelaySec(bpm), now);
    // A recipe may have retuned the network for its own join; the
    // echo-out's sound is the resting state, restored here.
    this.echoFeedback.gain.setValueAtTime(ECHO_DEFAULT_FEEDBACK, now);
    this.echoWet.gain.setValueAtTime(ECHO_DEFAULT_WET, now);
    const send = this.currentDeck.echoSend.gain;
    send.cancelScheduledValues(now);
    send.setTargetAtTime(0.9, now, 0.03);
    send.setTargetAtTime(0, now + 0.9, 0.1);
  }

  /** Which physical deck currently holds the playing track. */
  get currentDeckIndex(): DeckIndex {
    return this.current as DeckIndex;
  }

  /** Manual crossfader, -1 (deck 1 only) .. 1 (deck 2 only). */
  setCrossfade(position: number): void {
    this.crossfadePosition = Math.min(1, Math.max(-1, position));
    this.applyManualStage();
  }

  /** Manual per-deck volume trim, 0..1.25. */
  setDeckTrim(index: DeckIndex, level: number): void {
    this.deckTrimLevels[index] = Math.min(1.25, Math.max(0, level));
    this.applyManualStage();
  }

  /** Manual bass kill for one physical deck. */
  setDeckBassCut(index: DeckIndex, cut: boolean): void {
    this.decks[index].bassTrim.gain.setValueAtTime(
      cut ? BASS_CUT_DB : BASS_FLAT_DB,
      this.context.currentTime,
    );
  }

  private applyManualStage(): void {
    const [a, b] = crossfadeGains(this.crossfadePosition);
    const levels: [number, number] = [
      a * this.deckTrimLevels[0],
      b * this.deckTrimLevels[1],
    ];
    for (let i = 0; i < 2; i += 1) {
      this.trims[i].gain.setTargetAtTime(
        levels[i],
        this.context.currentTime,
        0.03,
      );
    }
  }

  /** The deck currently playing (or next to play). */
  get currentDeck(): Deck {
    return this.decks[this.current];
  }

  /** The idle deck, waiting for the next track. */
  get nextDeck(): Deck {
    return this.decks[1 - this.current];
  }

  /**
   * Starts a track on the current deck, full volume, natural tempo.
   * Returns the audio-clock time at which it starts.
   */
  playNow(buffer: AudioBuffer, offsetSec = 0, levelGain = 1): number {
    const deck = this.currentDeck;
    deck.load(buffer);
    deck.setLevel(levelGain);
    const now = this.context.currentTime;
    deck.gain.gain.setValueAtTime(1, now);
    deck.bass.gain.setValueAtTime(BASS_FLAT_DB, now);
    // Neutralise anything a previous recipe left on this deck, so a
    // plain start is plain: flat mid/high, open filter, no echo send,
    // no loop.
    deck.mid.gain.setValueAtTime(BASS_FLAT_DB, now);
    deck.high.gain.setValueAtTime(BASS_FLAT_DB, now);
    deck.filter.frequency.setValueAtTime(20_000, now);
    deck.echoSend.gain.setValueAtTime(0, now);
    deck.clearLoop();
    const startAt = now + SCHEDULE_AHEAD_SEC;
    deck.play(startAt, offsetSec, 1);
    return startAt;
  }

  /** Stops both decks and silences them. */
  stopAll(): void {
    const now = this.context.currentTime;
    for (const deck of this.decks) {
      deck.gain.gain.cancelScheduledValues(now);
      deck.gain.gain.setValueAtTime(0, now);
      deck.echoSend.gain.cancelScheduledValues(now);
      deck.echoSend.gain.setValueAtTime(0, now);
      deck.clearLoop();
      deck.stop(now);
    }
  }

  /**
   * Performs a planned transition into a new track on the idle deck.
   * The legacy seam: the plan is adapted to a recipe and performed by
   * the same executor as authored recipes, so there is one code path
   * that ever touches the decks. Returns the anchored blend start/end
   * so callers can track positions against the same clock.
   */
  transitionTo(
    nextBuffer: AudioBuffer,
    plan: TransitionPlan,
    levelGain = 1,
  ): { blendStartCtxTime: number; blendEndCtxTime: number } {
    return this.performRecipe(nextBuffer, recipeFromPlan(plan), { levelGain });
  }

  /**
   * Performs a recipe on the decks, exactly as written — after the
   * safety re-checks described in the header. Returns the anchored
   * overlap start/end on the audio clock.
   */
  performRecipe(
    nextBuffer: AudioBuffer,
    recipe: TransitionRecipe,
    options: PerformRecipeOptions = {},
  ): { blendStartCtxTime: number; blendEndCtxTime: number } {
    let working = recipe;

    // A B-side anchor (original track time) as a position in the
    // buffer actually being performed: divided by the stretch
    // factor when this recipe performs against a rendition.
    const bufferSecB = (originalSec: number, stretchB: number | null) =>
      stretchB !== null && stretchB > 0 ? originalSec / stretchB : originalSec;

    // Fingerprint check: a recipe is valid only for the audio it was
    // authored against (the REA beats-hash lesson). A mismatch — or a
    // structurally invalid recipe — performs the fallback plain cut.
    if (options.outgoing && options.incoming) {
      const fp = recipe.fingerprints;
      const versions = [
        options.outgoing.analysisVersion,
        options.incoming.analysisVersion,
      ].filter((v) => v !== undefined && v !== null);
      const mismatch =
        (fp.aAudioHash !== null &&
          options.outgoing.audioHash !== undefined &&
          fp.aAudioHash !== options.outgoing.audioHash) ||
        (fp.bAudioHash !== null &&
          options.incoming.audioHash !== undefined &&
          fp.bAudioHash !== options.incoming.audioHash) ||
        (fp.analysisVersion !== null &&
          versions.some((v) => v !== fp.analysisVersion));
      if (mismatch) {
        return this.performFallbackCut(
          nextBuffer,
          bufferSecB(recipe.overlap.startBMs / 1000, recipe.overlap.stretchB),
          options.levelGain ?? 1,
        );
      }
      // The referee's second reading: the analyses may have deepened
      // since authoring. It can only shorten, never lengthen, and
      // never changes the family at the decks.
      working = applyVocalReferee(working, options.outgoing, options.incoming);
    }
    if (validateRecipe(working).length > 0) {
      return this.performFallbackCut(
        nextBuffer,
        Number.isFinite(recipe.overlap.startBMs)
          ? bufferSecB(recipe.overlap.startBMs / 1000, recipe.overlap.stretchB)
          : 0,
        options.levelGain ?? 1,
      );
    }
    // A jog move on the outgoing deck anchors in A's track time
    // against the overlap's startAMs. The legacy relative form has
    // no anchor, so a recipe carrying an A-side move without one
    // cannot be placed — the fallback, never a guessed position.
    if (
      working.overlap.startAMs === null &&
      working.loops.some((l) => l.type !== "loop" && l.side === "A")
    ) {
      return this.performFallbackCut(
        nextBuffer,
        bufferSecB(recipe.overlap.startBMs / 1000, recipe.overlap.stretchB),
        options.levelGain ?? 1,
      );
    }

    const outgoing = this.currentDeck;
    const incoming = this.nextDeck;
    incoming.load(nextBuffer);
    incoming.setLevel(options.levelGain ?? 1);

    const a = working.automation;
    const durationSec = working.overlap.durationMs / 1000;
    const blendStart =
      this.context.currentTime +
      Math.max(SCHEDULE_AHEAD_SEC, working.leadInSec);
    const blendEnd = blendStart + durationSec;
    const startBSec = bufferSecB(
      working.overlap.startBMs / 1000,
      working.overlap.stretchB,
    );

    // The echo network takes the recipe's tuning for this join.
    if (working.fx.echo) {
      this.echoDelay.delayTime.setValueAtTime(
        working.fx.echo.delaySec,
        blendStart,
      );
      this.echoFeedback.gain.setValueAtTime(
        working.fx.echo.feedback,
        blendStart,
      );
      this.echoWet.gain.setValueAtTime(working.fx.echo.wet, blendStart);
    }

    // Loops, armed as written. A's loop engages when its playhead
    // reaches the region's end; B's is armed on its fresh source.
    // (Jog moves in the same array are not loops — they are
    // scheduled with the rate moves further down.)
    for (const loop of working.loops) {
      if (loop.type !== "loop") continue;
      if (loop.side === "A") {
        outgoing.setLoopRegion(loop.startMs / 1000, loop.endMs / 1000);
      }
    }

    // Jog-move geometry. A move's wall-clock start: A's playhead
    // left startAMs at blendStart and advances at rateA; B's track
    // time advances at rateB from startBMs (in rendition mode B's
    // ORIGINAL time also advances at rateB — the session's position
    // model — so one formula places B's moves in both modes). A
    // move's wall duration is its beats at its side's tempo, at its
    // side's rate.
    const jogMoves = working.loops.filter((l) => l.type !== "loop");
    const movesOn = (side: "A" | "B"): RecipeLoopBlock[] =>
      jogMoves.filter((l) => l.side === side);
    const moveStartCtx = (move: RecipeLoopBlock): number =>
      move.side === "A"
        ? blendStart +
          (move.startMs - (working.overlap.startAMs ?? 0)) /
            1000 /
            working.overlap.rateA
        : blendStart +
          (move.startMs - working.overlap.startBMs) /
            1000 /
            working.overlap.rateB;
    const moveDurationSec = (move: RecipeLoopBlock): number =>
      move.side === "A"
        ? (move.beats * (60 / working.overlap.bpmA)) / working.overlap.rateA
        : (move.beats * (60 / working.overlap.bpmB)) / working.overlap.rateB;

    // Incoming deck: start silent (or at the cut's full level), then
    // every curve the recipe wrote for it.
    const rateAtStart = automationValueAt(a.rateB, 0);
    incoming.play(blendStart, startBSec, rateAtStart);
    for (const loop of working.loops) {
      if (loop.type === "loop" && loop.side === "B") {
        incoming.setLoopRegion(
          bufferSecB(loop.startMs / 1000, working.overlap.stretchB),
          bufferSecB(loop.endMs / 1000, working.overlap.stretchB),
        );
      }
    }
    if (durationSec > 0) {
      scheduleSampledCurve(
        incoming.gain.gain,
        a.volumeIn,
        blendStart,
        durationSec,
      );
      scheduleSampledCurve(
        outgoing.gain.gain,
        a.volumeOut,
        blendStart,
        durationSec,
      );
    } else {
      incoming.gain.gain.setValueAtTime(
        automationValueAt(a.volumeIn, 0),
        blendStart,
      );
      outgoing.gain.gain.setValueAtTime(
        automationValueAt(a.volumeOut, 0),
        blendStart,
      );
    }
    scheduleEvents(incoming.bass.gain, a.eqIn.low, blendStart);
    scheduleEvents(incoming.mid.gain, a.eqIn.mid, blendStart);
    scheduleEvents(incoming.high.gain, a.eqIn.high, blendStart);
    scheduleEvents(incoming.filter.frequency, a.filterIn, blendStart);
    scheduleEvents(incoming.echoSend.gain, a.echoSendIn, blendStart);
    scheduleEvents(outgoing.bass.gain, a.eqOut.low, blendStart);
    scheduleEvents(outgoing.mid.gain, a.eqOut.mid, blendStart);
    scheduleEvents(outgoing.high.gain, a.eqOut.high, blendStart);
    scheduleEvents(outgoing.filter.frequency, a.filterOut, blendStart);
    scheduleEvents(outgoing.echoSend.gain, a.echoSendOut, blendStart);
    const rate = incoming.rateControl;
    if (rate) {
      const bMoves = movesOn("B");
      const bStops = bMoves.filter(isStopMove);
      const bNudges = bMoves.filter((m) => m.type === "nudge");
      if (bStops.length > 0) {
        // A stop move on the incoming deck takes the rate control
        // from its start: the written rate curve governs until
        // then, the move governs after — and the deck stops when
        // the last move ends. (Authoring never writes one — B is
        // the deck ARRIVING — but a recipe carrying one is
        // performed as written, not silently half-performed.)
        scheduleEvents(rate, a.rateB, blendStart);
        const first = Math.min(...bStops.map((m) => moveStartCtx(m)));
        rate.cancelScheduledValues(first);
        rate.setValueAtTime(
          automationValueAt(a.rateB, (first - blendStart) * 1000),
          first,
        );
        let lastEnd = first;
        for (const move of bStops) {
          scheduleStopMove(
            rate,
            move,
            moveStartCtx(move),
            moveDurationSec(move),
            working.overlap.rateB,
          );
          lastEnd = Math.max(
            lastEnd,
            moveStartCtx(move) + moveDurationSec(move),
          );
        }
        incoming.stop(lastEnd + 0.02);
      } else if (bNudges.length > 0) {
        // Nudge bends fold INTO B's written rate curve: the curve
        // is rendered sampled, each sample multiplied by the bends
        // in force at that moment — one writer on the parameter,
        // so bend and curve can never fight.
        const spans: NudgeSpan[] = bNudges.map((m) => ({
          startOffMs: (moveStartCtx(m) - blendStart) * 1000,
          durMs: moveDurationSec(m) * 1000,
          bend: m.bend ?? 1,
        }));
        const lastCurveMs =
          a.rateB.points.length > 0
            ? a.rateB.points[a.rateB.points.length - 1].atMs
            : 0;
        const spanSec =
          Math.max(
            lastCurveMs,
            ...spans.map((s) => s.startOffMs + s.durMs),
            1,
          ) / 1000;
        const values = new Float32Array(RATE_SAMPLES);
        for (let i = 0; i < RATE_SAMPLES; i += 1) {
          const atMs = (i / (RATE_SAMPLES - 1)) * spanSec * 1000;
          values[i] =
            automationValueAt(a.rateB, atMs) * nudgeFactorAt(spans, atMs);
        }
        rate.setValueCurveAtTime(values, blendStart, spanSec);
      } else {
        scheduleEvents(rate, a.rateB, blendStart);
      }
    }

    // The outgoing deck's jog moves, on its own rate control: a
    // nudge bends and returns; a stop move falls and does not come
    // back — and the deck's stop waits for the last stop move to
    // finish sounding rather than cutting it off at the blend's
    // written end.
    let outgoingStopCtx = blendEnd;
    const outRate = outgoing.rateControl;
    if (outRate) {
      for (const move of movesOn("A")) {
        const startCtx = moveStartCtx(move);
        const durSec = moveDurationSec(move);
        if (move.type === "nudge") {
          scheduleNudge(
            outRate,
            startCtx,
            durSec,
            working.overlap.rateA,
            move.bend ?? 1,
          );
        } else if (isStopMove(move)) {
          scheduleStopMove(
            outRate,
            move,
            startCtx,
            durSec,
            working.overlap.rateA,
          );
          outgoingStopCtx = Math.max(outgoingStopCtx, startCtx + durSec);
        }
      }
    }

    outgoing.stop(outgoingStopCtx + 0.05);

    this.current = 1 - this.current;
    return { blendStartCtxTime: blendStart, blendEndCtxTime: blendEnd };
  }

  /**
   * The recipe fallback, performed: B starts at its anchor at full
   * level and natural tempo on the idle deck, A stops. Never a forced
   * blend, never a throw into the session.
   */
  private performFallbackCut(
    nextBuffer: AudioBuffer,
    startBSec: number,
    levelGain: number,
  ): { blendStartCtxTime: number; blendEndCtxTime: number } {
    const outgoing = this.currentDeck;
    const incoming = this.nextDeck;
    incoming.load(nextBuffer);
    incoming.setLevel(levelGain);
    const start = this.context.currentTime + SCHEDULE_AHEAD_SEC;
    incoming.gain.gain.setValueAtTime(1, start);
    incoming.bass.gain.setValueAtTime(BASS_FLAT_DB, start);
    incoming.mid.gain.setValueAtTime(BASS_FLAT_DB, start);
    incoming.high.gain.setValueAtTime(BASS_FLAT_DB, start);
    incoming.filter.frequency.setValueAtTime(20_000, start);
    incoming.echoSend.gain.setValueAtTime(0, start);
    incoming.play(start, Math.max(0, startBSec), 1);
    outgoing.gain.gain.cancelScheduledValues(start);
    outgoing.gain.gain.setValueAtTime(0, start);
    outgoing.stop(start + 0.05);
    this.current = 1 - this.current;
    return { blendStartCtxTime: start, blendEndCtxTime: start };
  }
}
