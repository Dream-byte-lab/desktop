import type { TrackAnalysis } from "./analyseTrack";
import { BASS_CUT_DB, BASS_FLAT_DB, Deck } from "./deck";
import {
  automationValueAt,
  recipeFromPlan,
  validateRecipe,
  type AutomationCurve,
  type RecipeEffectKind,
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
// Scratches (the revamp's R2) are performed here as well: a scratch
// block drives its deck's rate as a hand motion (forward strokes
// and their return strokes, alternating) while the deck's scratch
// gate plays the technique's fader pattern — baby leaves the gate
// open, chirp closes it on the push and opens it on the pull,
// transformer clicks it at a stated rhythm over a slow hand, flare
// opens it mid-stroke and clicks it shut at each extreme. The hand
// is advance-exact: each stroke's excess over the written rate is
// repaid by its return, so the deck's position at the window's end
// is exactly where unperturbed playback would have put it, and the
// rate and the gate are both home (written rate, gate open) at
// that same instant.
//
// Effects (the revamp's R3) are performed here as well: a recipe's
// fx configs tune SHARED networks (reverb, delay, flanger, phaser,
// distortion, spiral, roll) and its effect blocks open a deck's
// send into one of them for a window of that side's track time —
// or, for trans, chop the deck through its fx gate, and for roll,
// capture a slice into the roll network and let it circulate
// alone. The networks are built LAZILY, on the first recipe that
// names them: the constructor creates only their input gains, so
// a plain recipe creates no convolver, oscillator, waveshaper or
// buffer and schedules no new automation — its performance is
// byte-identical to before. The one-writer discipline holds
// throughout: each send is written only by effect performance
// (and by the neutralisations that return it to 0), the fx gate
// only by trans, each network's tuning only at a blend's start or
// inside its own block's choreography. And a referee-safety clamp
// guards every block: the vocal referee may have shortened the
// blend after authoring, so a block that starts inside the
// overlap may not outlive the PERFORMED overlap's end.
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

/** A scratch block (the revamp's R2): hand motion plus fader work. */
function isScratchMove(move: RecipeLoopBlock): boolean {
  return move.type === "scratch";
}

/** How fast a scratch gate closes, in seconds — a click, not a fade. */
const GATE_CLICK_SEC = 0.003;
/** How fast a scratch gate opens, in seconds. */
const GATE_OPEN_SEC = 0.002;

/**
 * Schedules a scratch's HAND on a deck's rate control: `strokes`
 * forward strokes, each followed by its return stroke, each stroke
 * lasting half a cycle. The forward stroke runs at base + slope and
 * the return at base − slope, where slope carries the record
 * through `excursionBeats` of audio per stroke — so each stroke's
 * excess over the written rate is repaid exactly by its return,
 * and the deck's position at the window's end is the position
 * unperturbed playback promised (the advance-exact invariant the
 * recipe documents). The final event pins the rate home: a scratch
 * is a visit, not a tempo.
 */
function scheduleScratchHand(
  param: AudioParam,
  move: RecipeLoopBlock,
  startCtx: number,
  durationSec: number,
  baseRate: number,
  bpm: number,
): void {
  const strokes = Math.max(1, move.strokes ?? 1);
  const halfSec = durationSec / (strokes * 2);
  const excursionSec = (move.excursionBeats ?? 0.5) * (60 / bpm);
  const slope = halfSec > 0 ? excursionSec / halfSec : 0;
  for (let k = 0; k < strokes * 2; k += 1) {
    param.setValueAtTime(
      k % 2 === 0 ? baseRate + slope : baseRate - slope,
      startCtx + k * halfSec,
    );
  }
  param.setValueAtTime(baseRate, startCtx + durationSec);
}

/**
 * Schedules a scratch's FADER on the deck's scratch gate — the
 * technique is the pattern:
 *
 * - baby: no events at all. The gate rests open; the hand alone is
 *   the sound. (An empty event list is the assertion the tests make.)
 * - chirp: the gate closes as the record pushes forward and opens
 *   as it pulls back — one close and one open per stroke pair.
 * - transformer: the gate clicks on a stated rhythm
 *   (`clicksPerBeat`) while the hand drags slowly — the rhythm is
 *   the fader's, not the hand's. Whatever the click count's parity,
 *   the gate is OPEN at the window's end.
 * - flare (1-click): the gate is shut AT each stroke extreme,
 *   opens through the stroke's first fifth, holds open across its
 *   middle, and clicks shut across its last fifth at the next
 *   extreme; the final extreme is the release, so the gate is
 *   open again exactly at the window's end.
 *
 * Every transition is ANCHORED — a setValueAtTime of the standing
 * value at the moment the fader starts to move, then the short
 * ramp. A bare ramp would interpolate from the PREVIOUS event's
 * time, smearing the click across the whole span since it; the
 * anchor is what makes a click a click.
 */
function scheduleScratchGate(
  param: AudioParam,
  move: RecipeLoopBlock,
  startCtx: number,
  durationSec: number,
): void {
  const endCtx = startCtx + durationSec;
  if (move.technique === "chirp") {
    const strokes = Math.max(1, move.strokes ?? 1);
    const cycleSec = durationSec / strokes;
    param.setValueAtTime(1, startCtx);
    for (let k = 0; k < strokes; k += 1) {
      const forwardStart = startCtx + k * cycleSec;
      const backStart = forwardStart + cycleSec / 2;
      if (k > 0) param.setValueAtTime(1, forwardStart);
      param.linearRampToValueAtTime(0, forwardStart + GATE_CLICK_SEC);
      param.setValueAtTime(0, backStart);
      param.linearRampToValueAtTime(1, backStart + GATE_OPEN_SEC);
    }
    param.setValueAtTime(1, endCtx);
  } else if (move.technique === "transformer") {
    const clicksPerBeat = move.clicksPerBeat ?? 2;
    const totalClicks = move.beats * clicksPerBeat;
    param.setValueAtTime(1, startCtx);
    let open = true;
    for (let k = 1; k <= Math.floor(totalClicks + 1e-9); k += 1) {
      const t = startCtx + (k * durationSec) / totalClicks;
      if (t >= endCtx - GATE_CLICK_SEC) break;
      param.setValueAtTime(open ? 1 : 0, t);
      open = !open;
      param.linearRampToValueAtTime(
        open ? 1 : 0,
        t + (open ? GATE_OPEN_SEC : GATE_CLICK_SEC),
      );
    }
    if (!open) {
      // An odd click count leaves the gate shut; the window must
      // still end honest — open, on time.
      param.setValueAtTime(0, endCtx - 0.004);
      param.linearRampToValueAtTime(1, endCtx);
    } else {
      param.setValueAtTime(1, endCtx);
    }
  } else if (move.technique === "flare") {
    const strokes = Math.max(1, move.strokes ?? 1);
    const halfSec = durationSec / (strokes * 2);
    const strokeCount = strokes * 2;
    param.setValueAtTime(0, startCtx);
    for (let s = 0; s < strokeCount; s += 1) {
      const strokeStart = startCtx + s * halfSec;
      param.linearRampToValueAtTime(1, strokeStart + halfSec * 0.2);
      param.setValueAtTime(1, strokeStart + halfSec * 0.8);
      if (s === strokeCount - 1) {
        param.linearRampToValueAtTime(0, endCtx - 0.004);
        param.linearRampToValueAtTime(1, endCtx);
      } else {
        param.linearRampToValueAtTime(0, strokeStart + halfSec);
      }
    }
  }
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

/**
 * The distortion network's curve: a 1024-point tanh-style curve
 * from the config's amount. The drive `k = 1 + amount × 10`
 * steepens the tanh; dividing by tanh(k) keeps the endpoints at
 * ±1, so louder amounts saturate harder without simply getting
 * louder. At amount 0 the curve is tanh itself — gentle, not
 * identity — which is honest: the network is a saturator, and a
 * recipe that sends into it has asked for saturation.
 */
function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(1024);
  const k = 1 + amount * 10;
  const norm = Math.tanh(k);
  for (let i = 0; i < 1024; i += 1) {
    const x = (i / 1023) * 2 - 1;
    curve[i] = Math.tanh(k * x) / norm;
  }
  return curve;
}

/**
 * Schedules a send-class effect block's envelope on a deck's send
 * gain: anchored at 0, ramping to the block's level over the
 * attack, holding, then ramping back to 0 over the last 0.05 s,
 * with a final set at 0 — no tail rings past what the network's
 * own decay does once the send is closed.
 */
function scheduleSendEnvelope(
  param: AudioParam,
  startCtx: number,
  endCtx: number,
  level: number,
  attackSec: number,
): void {
  const duration = Math.max(0, endCtx - startCtx);
  const attack = Math.min(attackSec, duration / 2);
  const releaseStart = Math.max(startCtx + attack, endCtx - 0.05);
  param.setValueAtTime(0, startCtx);
  param.linearRampToValueAtTime(level, startCtx + attack);
  if (releaseStart > startCtx + attack) {
    param.setValueAtTime(level, releaseStart);
  }
  param.linearRampToValueAtTime(0, endCtx);
  param.setValueAtTime(0, endCtx);
}

/**
 * Schedules a trans block's gate pattern on a deck's fx gate,
 * anchored like scheduleScratchGate: within each cycle the gate
 * ramps (0.002 s) to (1 − depth) for the first half and back to 1
 * for the second. The first event pins the gate home and the
 * final event pins it home again — the gate is ALWAYS home at
 * the window's end.
 */
function scheduleTransGate(
  param: AudioParam,
  startCtx: number,
  endCtx: number,
  cycleSec: number,
  depth: number,
): void {
  const dip = 1 - depth;
  param.setValueAtTime(1, startCtx);
  if (!(cycleSec > 0)) {
    param.setValueAtTime(1, endCtx);
    return;
  }
  let t = startCtx;
  while (t < endCtx - 1e-9) {
    const half = t + cycleSec / 2;
    param.linearRampToValueAtTime(dip, t + 0.002);
    if (half < endCtx) {
      param.setValueAtTime(dip, half);
      param.linearRampToValueAtTime(1, half + 0.002);
    }
    t += cycleSec;
    if (t < endCtx - 1e-9) param.setValueAtTime(1, t);
  }
  param.setValueAtTime(1, endCtx);
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

/** The crossfader laws the manual stage can lean with (the DJ stage's curve setting). */
export type CrossfaderCurveName = "smooth" | "constant-power" | "cut";

/**
 * Crossfader gains for a position in -1..1. This crossfader is a lean
 * control layered over the automation, not the primary fader, so the
 * centre is transparent (both decks at full) — an untouched crossfader
 * must never change what the automatic blends sound like. Moving it
 * fades the opposite deck out, along the chosen curve:
 *
 * - "smooth" (the original law): the faded deck follows a cosine.
 * - "constant-power": the faded deck's gain is sqrt(1 − |p|) — its
 *   POWER (gain²) falls linearly with the lean, so the combined power
 *   of the two decks stays constant through the sweep.
 * - "cut": the faded deck stays at full until the lean reaches 0.65,
 *   then drops straight to 0 — a scratch-style cut, not a fade.
 *
 * The leaned-to deck stays at 1 under every curve, and the centre is
 * transparent under every curve.
 */
export function crossfadeGains(
  position: number,
  curve: CrossfaderCurveName = "smooth",
): [number, number] {
  const p = Math.min(1, Math.max(-1, position));
  const lean = Math.abs(p);
  const faded =
    curve === "constant-power"
      ? Math.sqrt(1 - lean)
      : curve === "cut"
        ? lean < 0.65
          ? 1
          : 0
        : Math.cos((lean * Math.PI) / 2);
  const deck1 = p <= 0 ? 1 : faded;
  const deck2 = p >= 0 ? 1 : faded;
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

interface ReverbNetwork {
  convolver: ConvolverNode;
  wet: GainNode;
  builtDecaySec: number;
}
interface DelayNetwork {
  delay: DelayNode;
  feedback: GainNode;
  wet: GainNode;
}
interface FlangerNetwork {
  delay: DelayNode;
  feedback: GainNode;
  wet: GainNode;
  osc: OscillatorNode;
  depthGain: GainNode;
}
interface PhaserNetwork {
  filters: BiquadFilterNode[];
  centres: number[];
  wet: GainNode;
  osc: OscillatorNode;
  depthGains: GainNode[];
}
interface DistortionNetwork {
  drive: GainNode;
  shaper: WaveShaperNode;
  wet: GainNode;
}
interface RollNetwork {
  delay: DelayNode;
  feedback: GainNode;
  wet: GainNode;
}

/**
 * One deck's live manual-stage readings, for the DJ stage's snapshot:
 * the values the deck's own nodes hold right now (read at call time,
 * never sampled on a timer).
 */
export interface DeckStageReadings {
  /** The deck gain's current value (the blend curves write it). */
  gainValue: number;
  /** The playing source's playback-rate ratio (1 = original tempo; 1 when idle). */
  rateValue: number;
  /** The EQ biquads' current gains, in dB. */
  bassDb: number;
  midDb: number;
  highDb: number;
  /** The lowpass filter's current cutoff, in Hz (20,000 = fully open). */
  filterHz: number;
}

/**
 * One effect's live manual-stage readings, for the DJ stage's
 * snapshot: whether its shared network has been built yet, the
 * network's wet-return level, and each deck's send level into it.
 * Unbuilt networks report null levels — absence is data, not 0.
 */
export interface EffectStageReadings {
  built: boolean;
  wetLevel: number | null;
  sendLevels: { A: number | null; B: number | null };
}

/** Where an effect's manual focus sits: one deck, both, or none. */
type ManualFxAssign = "A" | "B" | "both" | null;

interface ManualFxState {
  assign: ManualFxAssign;
  levels: { A: number; B: number };
}

export class TwoDeckMixer {
  readonly master: GainNode;
  private readonly decks: [Deck, Deck];
  private readonly trims: [GainNode, GainNode];
  private readonly echoDelay: DelayNode;
  private readonly echoFeedback: GainNode;
  private readonly echoWet: GainNode;
  // The R3 effect networks' INPUT gains and the delay→reverb
  // cascade gain. These are the ONLY R3 nodes the constructor
  // creates (all createGain): the networks behind the inputs are
  // built lazily, on the first recipe that names them, because
  // the hand-written fake contexts in the existing suites offer
  // nothing beyond createGain / createBiquadFilter / createDelay /
  // createBufferSource. A plain recipe must create nothing more.
  private readonly reverbInput: GainNode;
  private readonly delayInput: GainNode;
  private readonly flangerInput: GainNode;
  private readonly phaserInput: GainNode;
  private readonly distortionInput: GainNode;
  private readonly spiralInput: GainNode;
  private readonly rollInput: GainNode;
  private readonly cascadeGain: GainNode;
  private cascadeWired = false;
  private reverbNet: ReverbNetwork | null = null;
  private delayNet: DelayNetwork | null = null;
  private spiralNet: DelayNetwork | null = null;
  private flangerNet: FlangerNetwork | null = null;
  private phaserNet: PhaserNetwork | null = null;
  private distortionNet: DistortionNetwork | null = null;
  private rollNet: RollNetwork | null = null;
  private current = 0;
  private crossfadePosition = 0;
  private crossfaderCurve: CrossfaderCurveName = "smooth";
  private readonly deckTrimLevels: [number, number] = [1, 1];
  // The stage's lazy analyser taps — the R3 lazy pattern applied to
  // metering. The constructor creates NONE of these: a tap is built
  // on the first read that asks for it (deckAnalyser /
  // masterAnalyser / the meter summaries), so a plain performance
  // creates no analyser at all.
  private readonly deckAnalyserNodes: [
    AnalyserNode | null,
    AnalyserNode | null,
  ] = [null, null];
  private masterAnalyserNode: AnalyserNode | null = null;
  // The manual FX stage's remembered state, per effect kind. This
  // is STATE ONLY — the sends themselves are written through
  // writeManualFxSend, so the one-writer story stays readable.
  private readonly manualFxStates = new Map<RecipeEffectKind, ManualFxState>();

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

    // The R3 network inputs and cascade: plain gains, resting
    // transparent (inputs at 1) and silent (cascade at 0). The
    // networks themselves are NOT built here — see the field note.
    this.reverbInput = context.createGain();
    this.delayInput = context.createGain();
    this.flangerInput = context.createGain();
    this.phaserInput = context.createGain();
    this.distortionInput = context.createGain();
    this.spiralInput = context.createGain();
    this.rollInput = context.createGain();
    this.cascadeGain = context.createGain();
    this.cascadeGain.gain.value = 0;

    // The manual stage: each deck runs through its own trim gain before
    // the master. The automation writes the decks' own gains; hands
    // (the Pro layer) write these trims and the crossfader. Because the
    // two multiply rather than share one control, a hand on the mixer
    // can lean on a blend but can never corrupt its scheduling.
    this.trims = [context.createGain(), context.createGain()];
    for (const trim of this.trims) trim.connect(this.master);
    const fxInputs = {
      reverb: this.reverbInput,
      delay: this.delayInput,
      flanger: this.flangerInput,
      phaser: this.phaserInput,
      distortion: this.distortionInput,
      spiral: this.spiralInput,
      roll: this.rollInput,
    };
    this.decks = [
      new Deck(context, this.trims[0], this.echoDelay, fxInputs),
      new Deck(context, this.trims[1], this.echoDelay, fxInputs),
    ];
  }

  // --- The lazy R3 networks -------------------------------------
  // Each builder runs once, on the first recipe that names its
  // effect, and wires input → processing → wet gain → master.
  // Only these builders may create node types beyond the four
  // factories the constructor is allowed.

  private generateReverbIR(decaySec: number): AudioBuffer {
    const sampleRate = this.context.sampleRate;
    const len = Math.max(1, Math.round(decaySec * sampleRate));
    const buffer = this.context.createBuffer(2, len, sampleRate);
    for (let ch = 0; ch < 2; ch += 1) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < len; i += 1) {
        const t = len > 0 ? i / len : 0;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.5);
      }
    }
    return buffer;
  }

  private ensureReverb(decaySec?: number): ReverbNetwork {
    if (!this.reverbNet) {
      const convolver = this.context.createConvolver();
      const wet = this.context.createGain();
      wet.gain.value = 0;
      this.reverbInput.connect(convolver);
      convolver.connect(wet);
      wet.connect(this.master);
      const decay = decaySec ?? 2;
      convolver.buffer = this.generateReverbIR(decay);
      this.reverbNet = { convolver, wet, builtDecaySec: decay };
    } else if (
      decaySec !== undefined &&
      decaySec !== this.reverbNet.builtDecaySec
    ) {
      // A performance whose decay differs from the built one
      // regenerates the impulse — the room itself changes size.
      this.reverbNet.convolver.buffer = this.generateReverbIR(decaySec);
      this.reverbNet.builtDecaySec = decaySec;
    }
    this.tryWireCascade();
    return this.reverbNet;
  }

  private ensureDelay(): DelayNetwork {
    if (!this.delayNet) {
      const delay = this.context.createDelay(2);
      delay.delayTime.value = 0.3;
      // Brighter loop than the echo network's 1200 Hz — the
      // audible distinction: delay stays rhythmic, echo dissolves
      // dark.
      const filter = this.context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 6000;
      const feedback = this.context.createGain();
      feedback.gain.value = 0;
      const wet = this.context.createGain();
      wet.gain.value = 0;
      this.delayInput.connect(delay);
      delay.connect(filter);
      filter.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(this.master);
      this.delayNet = { delay, feedback, wet };
    }
    this.tryWireCascade();
    return this.delayNet;
  }

  private ensureSpiral(): DelayNetwork {
    if (!this.spiralNet) {
      const delay = this.context.createDelay(2);
      delay.delayTime.value = 0.3;
      const filter = this.context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 4000;
      const feedback = this.context.createGain();
      feedback.gain.value = 0;
      const wet = this.context.createGain();
      wet.gain.value = 0;
      this.spiralInput.connect(delay);
      delay.connect(filter);
      filter.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(this.master);
      this.spiralNet = { delay, feedback, wet };
    }
    return this.spiralNet;
  }

  private ensureFlanger(): FlangerNetwork {
    if (!this.flangerNet) {
      const delay = this.context.createDelay(2);
      delay.delayTime.value = 0.004;
      const feedback = this.context.createGain();
      feedback.gain.value = 0;
      const wet = this.context.createGain();
      wet.gain.value = 0;
      const osc = this.context.createOscillator();
      const depthGain = this.context.createGain();
      depthGain.gain.value = 0;
      this.flangerInput.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(this.master);
      // The send-flanger works against the dry signal: the deck's
      // own dry path (through its gain to the master) is the other
      // half of the comb — the swept delayed copy interferes with
      // it, which is the flanger's sound. Nothing here touches
      // the dry path itself.
      osc.connect(depthGain);
      depthGain.connect(delay.delayTime);
      osc.start();
      this.flangerNet = { delay, feedback, wet, osc, depthGain };
    }
    return this.flangerNet;
  }

  private ensurePhaser(): PhaserNetwork {
    if (!this.phaserNet) {
      const centres = [400, 800, 1600, 3200];
      const filters: BiquadFilterNode[] = [];
      const wet = this.context.createGain();
      wet.gain.value = 0;
      const osc = this.context.createOscillator();
      const depthGains: GainNode[] = [];
      let prev: AudioNode = this.phaserInput;
      for (const centre of centres) {
        const f = this.context.createBiquadFilter();
        f.type = "allpass";
        f.frequency.value = centre;
        prev.connect(f);
        filters.push(f);
        prev = f;
        const dg = this.context.createGain();
        dg.gain.value = 0;
        osc.connect(dg);
        dg.connect(f.frequency);
        depthGains.push(dg);
      }
      prev.connect(wet);
      wet.connect(this.master);
      osc.start();
      this.phaserNet = { filters, centres, wet, osc, depthGains };
    }
    return this.phaserNet;
  }

  private ensureDistortion(): DistortionNetwork {
    if (!this.distortionNet) {
      const drive = this.context.createGain();
      drive.gain.value = 1;
      const shaper = this.context.createWaveShaper();
      shaper.oversample = "2x";
      const wet = this.context.createGain();
      wet.gain.value = 0;
      // PARALLEL saturation — the dry path is never touched: the
      // send feeds this network alongside the deck's clean signal,
      // and only the wet return is saturated. A deliberate, stated
      // design decision, not an insert crush.
      this.distortionInput.connect(drive);
      drive.connect(shaper);
      shaper.connect(wet);
      wet.connect(this.master);
      this.distortionNet = { drive, shaper, wet };
    }
    return this.distortionNet;
  }

  private ensureRoll(): RollNetwork {
    if (!this.rollNet) {
      const delay = this.context.createDelay(2);
      delay.delayTime.value = 0.25;
      const feedback = this.context.createGain();
      feedback.gain.value = 0;
      const wet = this.context.createGain();
      wet.gain.value = 0;
      this.rollInput.connect(delay);
      delay.connect(feedback);
      feedback.connect(delay);
      delay.connect(wet);
      wet.connect(this.master);
      this.rollNet = { delay, feedback, wet };
    }
    return this.rollNet;
  }

  private tryWireCascade(): void {
    if (this.cascadeWired) return;
    if (!this.delayNet || !this.reverbNet) return;
    this.delayNet.wet.connect(this.cascadeGain);
    this.cascadeGain.connect(this.reverbInput);
    this.cascadeWired = true;
  }

  /**
   * Schedules every effect block in a recipe. Window placement
   * uses the jog formulas (see performRecipe): a block's track
   * window converts at its side's rate. The referee-safety clamp
   * (see the header) shortens a block that starts inside the
   * overlap so no envelope outlives the performed blend; blocks
   * starting before the overlap (the chop window) are unclamped.
   */
  private scheduleEffectBlocks(
    working: TransitionRecipe,
    outgoing: Deck,
    incoming: Deck,
    blendStart: number,
  ): void {
    const blocks = working.effects ?? [];
    if (blocks.length === 0) return;
    for (const block of blocks) {
      const isA = block.side === "A";
      const deck = isA ? outgoing : incoming;
      const rate = isA ? working.overlap.rateA : working.overlap.rateB;
      const bpm = isA ? working.overlap.bpmA : working.overlap.bpmB;
      const overlapStartTrack = isA
        ? working.overlap.startAMs
        : working.overlap.startBMs;
      let endTrack = block.endMs;
      if (overlapStartTrack !== null && block.startMs >= overlapStartTrack) {
        const overlapEndTrack = isA
          ? overlapStartTrack + working.overlap.durationMs
          : overlapStartTrack +
            working.overlap.durationMs * working.overlap.rateB;
        endTrack = Math.min(endTrack, overlapEndTrack);
      }
      if (endTrack <= block.startMs) continue;
      const anchor = overlapStartTrack ?? 0;
      const startCtx =
        blendStart + (block.startMs - anchor) / 1000 / (rate || 1);
      const endCtx = blendStart + (endTrack - anchor) / 1000 / (rate || 1);
      const duration = endCtx - startCtx;
      if (!(duration > 0)) continue;
      if (block.kind === "trans") {
        const cfg = working.fx.trans;
        if (!cfg) continue;
        const cycleSec = cfg.divisionBeats * (60 / bpm);
        scheduleTransGate(
          deck.fxGate.gain,
          startCtx,
          endCtx,
          cycleSec,
          cfg.depth,
        );
      } else if (block.kind === "roll") {
        const cfg = working.fx.roll;
        const net = this.rollNet;
        if (!cfg || !net) continue;
        const sliceSec = cfg.sliceBeats * (60 / bpm);
        net.delay.delayTime.setValueAtTime(sliceSec, startCtx);
        net.feedback.gain.setValueAtTime(cfg.feedback, startCtx);
        net.wet.gain.setValueAtTime(1, startCtx);
        const send = deck.rollSend.gain;
        send.setValueAtTime(0, startCtx);
        send.linearRampToValueAtTime(block.level, startCtx + 0.005);
        // The capture closes one slice later: the send returns to
        // 0 and the slice circulates alone in the network while
        // the deck plays on — a true slip roll, NOT the source
        // loop (the deck never loops; only the captured slice
        // repeats, in the delay).
        send.setValueAtTime(block.level, startCtx + sliceSec);
        send.linearRampToValueAtTime(0, startCtx + sliceSec + 0.005);
        // The tail dies inside the recipe, never into the next
        // track: feedback and wet ramp home at the window's end.
        net.feedback.gain.setValueAtTime(
          cfg.feedback,
          Math.max(startCtx, endCtx - 0.03),
        );
        net.feedback.gain.linearRampToValueAtTime(0, endCtx);
        net.wet.gain.setValueAtTime(1, Math.max(startCtx, endCtx - 0.05));
        net.wet.gain.linearRampToValueAtTime(0, endCtx);
      } else {
        // Send-class: reverb / delay / flanger / phaser /
        // distortion / spiral — an envelope on the deck's send.
        const send =
          block.kind === "reverb"
            ? deck.reverbSend.gain
            : block.kind === "delay"
              ? deck.delaySend.gain
              : block.kind === "flanger"
                ? deck.flangerSend.gain
                : block.kind === "phaser"
                  ? deck.phaserSend.gain
                  : block.kind === "distortion"
                    ? deck.distortionSend.gain
                    : deck.spiralSend.gain;
        const attack =
          block.kind === "reverb" ? Math.min(0.5, 0.25 * duration) : 0.03;
        scheduleSendEnvelope(send, startCtx, endCtx, block.level, attack);
        if (block.kind === "spiral") {
          const cfg = working.fx.spiral;
          const net = this.spiralNet;
          if (cfg && net) {
            net.delay.delayTime.setValueAtTime(cfg.delaySec, startCtx);
            net.delay.delayTime.exponentialRampToValueAtTime(
              cfg.delaySec * cfg.sweepToRatio,
              endCtx,
            );
          }
        }
      }
    }
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

  /** The manual stage's crossfader law, re-applied to the standing lean at once. */
  setCrossfaderCurve(curve: CrossfaderCurveName): void {
    this.crossfaderCurve = curve;
    this.applyManualStage();
  }

  /** The crossfader law the manual stage is currently leaning with. */
  crossfaderCurveName(): CrossfaderCurveName {
    return this.crossfaderCurve;
  }

  /**
   * Manual EQ for one physical deck — the stage's hand on one band.
   * Honest overwrite semantics: this writes the SAME biquad gain the
   * recipe executor's EQ automation writes, so the executor's next
   * performance on that deck overwrites a manual grab (and a grab
   * overwrites a standing automated value until then). The manual
   * stage does NOT re-apply grabs after a performance.
   */
  setDeckEq(index: DeckIndex, band: "bass" | "mid" | "high", db: number): void {
    const deck = this.decks[index];
    const node =
      band === "bass" ? deck.bass : band === "mid" ? deck.mid : deck.high;
    const clamped = Math.min(24, Math.max(-24, db));
    node.gain.setValueAtTime(clamped, this.context.currentTime);
  }

  /**
   * Manual filter cutoff for one physical deck. Same overwrite
   * semantics as setDeckEq: the executor's filter automation writes
   * this same parameter and wins on its next performance.
   */
  setDeckFilter(index: DeckIndex, hz: number): void {
    const clamped = Math.min(20_000, Math.max(20, hz));
    this.decks[index].filter.frequency.setValueAtTime(
      clamped,
      this.context.currentTime,
    );
  }

  // --- The stage's lazy analyser taps ----------------------------
  // Built on first request only, one per deck plus one on the
  // master, then cached for the mixer's lifetime. A context that
  // cannot create an analyser (the hand-written fakes, an exotic
  // runtime) leaves the tap unbuilt and every read reports null —
  // the stage renders that honestly as "no meter path".

  /** The deck's analyser tap, built on first call; null when the context cannot make one. */
  deckAnalyser(index: DeckIndex): AnalyserNode | null {
    const cached = this.deckAnalyserNodes[index];
    if (cached) return cached;
    const node = this.createAnalyserTap();
    if (!node) return null;
    this.decks[index].gain.connect(node);
    this.deckAnalyserNodes[index] = node;
    return node;
  }

  /** The master analyser tap, built on first call; null when the context cannot make one. */
  masterAnalyser(): AnalyserNode | null {
    if (this.masterAnalyserNode) return this.masterAnalyserNode;
    const node = this.createAnalyserTap();
    if (!node) return null;
    this.master.connect(node);
    this.masterAnalyserNode = node;
    return node;
  }

  private createAnalyserTap(): AnalyserNode | null {
    try {
      const factory = this.context.createAnalyser;
      if (typeof factory !== "function") return null;
      const node = factory.call(this.context);
      node.fftSize = 2048;
      return node;
    } catch {
      return null;
    }
  }

  /**
   * The deck's peak/RMS summary, computed from the tap's time-domain
   * data AT CALL TIME — no timers, no stored state. Null when no tap
   * can be built.
   */
  deckMeterSummary(index: DeckIndex): { peak: number; rms: number } | null {
    const tap = this.deckAnalyser(index);
    return tap ? this.meterSummary(tap) : null;
  }

  /** The master's peak/RMS summary; same contract as deckMeterSummary. */
  masterMeterSummary(): { peak: number; rms: number } | null {
    const tap = this.masterAnalyser();
    return tap ? this.meterSummary(tap) : null;
  }

  private meterSummary(analyser: AnalyserNode): { peak: number; rms: number } {
    const size = analyser.fftSize > 0 ? analyser.fftSize : 2048;
    let samples: ArrayLike<number> | null = null;
    if (typeof analyser.getFloatTimeDomainData === "function") {
      const data = new Float32Array(size);
      analyser.getFloatTimeDomainData(data);
      samples = data;
    } else if (typeof analyser.getByteTimeDomainData === "function") {
      const bytes = new Uint8Array(size);
      analyser.getByteTimeDomainData(bytes);
      const data = new Float32Array(bytes.length);
      for (let i = 0; i < bytes.length; i += 1)
        data[i] = (bytes[i] - 128) / 128;
      samples = data;
    }
    if (!samples || samples.length === 0) return { peak: 0, rms: 0 };
    let peak = 0;
    let sumSquares = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const magnitude = Math.abs(samples[i]);
      if (magnitude > peak) peak = magnitude;
      sumSquares += samples[i] * samples[i];
    }
    return { peak, rms: Math.sqrt(sumSquares / samples.length) };
  }

  // --- Stage readings ---------------------------------------------
  // Read-only views over the nodes as they stand, for the stage
  // snapshot: the values are the params' `.value`s at call time.

  /** One deck's live readings (gain, rate, EQ, filter). */
  stageDeckReadings(index: DeckIndex): DeckStageReadings {
    const deck = this.decks[index];
    return {
      gainValue: deck.gain.gain.value,
      rateValue: deck.rateControl?.value ?? 1,
      bassDb: deck.bass.gain.value,
      midDb: deck.mid.gain.value,
      highDb: deck.high.gain.value,
      filterHz: deck.filter.frequency.value,
    };
  }

  /** One effect's live readings (built?, wet return, per-deck sends). */
  stageEffectReadings(kind: RecipeEffectKind): EffectStageReadings {
    if (kind === "trans") {
      // trans has no lazy network and no sends: its stage is the
      // per-deck fx gate, a permanent part of the deck chain, so it
      // is always "built" and its levels are honestly unreadable.
      return { built: true, wetLevel: null, sendLevels: { A: null, B: null } };
    }
    const net = this.effectNetwork(kind);
    if (!net) {
      return { built: false, wetLevel: null, sendLevels: { A: null, B: null } };
    }
    return {
      built: true,
      wetLevel: net.wet.gain.value,
      sendLevels: {
        A: this.deckSendNode(this.decks[0], kind)?.gain.value ?? null,
        B: this.deckSendNode(this.decks[1], kind)?.gain.value ?? null,
      },
    };
  }

  /** The built network behind a send-class kind, or null while unbuilt. */
  private effectNetwork(kind: RecipeEffectKind): { wet: GainNode } | null {
    switch (kind) {
      case "reverb":
        return this.reverbNet;
      case "delay":
        return this.delayNet;
      case "spiral":
        return this.spiralNet;
      case "flanger":
        return this.flangerNet;
      case "phaser":
        return this.phaserNet;
      case "distortion":
        return this.distortionNet;
      case "roll":
        return this.rollNet;
      default:
        return null;
    }
  }

  /** A deck's send node into a kind's network (null for trans, which has none). */
  private deckSendNode(deck: Deck, kind: RecipeEffectKind): GainNode | null {
    switch (kind) {
      case "reverb":
        return deck.reverbSend;
      case "delay":
        return deck.delaySend;
      case "spiral":
        return deck.spiralSend;
      case "flanger":
        return deck.flangerSend;
      case "phaser":
        return deck.phaserSend;
      case "distortion":
        return deck.distortionSend;
      case "roll":
        return deck.rollSend;
      default:
        return null;
    }
  }

  // --- The manual FX stage ----------------------------------------
  // The stage's hands on the shared effects: an assign (which deck
  // or decks an effect is focused on) plus a remembered send level
  // per side. Honest overwrite semantics, as with setDeckEq: these
  // setters write the SAME send params the recipe executor's effect
  // performance writes, so the executor's next performance on that
  // deck overwrites a manual grab — and playNow / stopAll
  // neutralisations zero the sends outright. The manual stage does
  // NOT auto-reapply after either; a grab lasts until the next
  // performance, neutralisation, or manual change.

  private manualFxState(kind: RecipeEffectKind): ManualFxState {
    let state = this.manualFxStates.get(kind);
    if (!state) {
      state = { assign: null, levels: { A: 0, B: 0 } };
      this.manualFxStates.set(kind, state);
    }
    return state;
  }

  /** The effect's current manual assign. */
  manualFxAssign(kind: RecipeEffectKind): ManualFxAssign {
    return this.manualFxState(kind).assign;
  }

  /**
   * Moves an effect's manual focus, re-applying both sides' sends
   * from the remembered levels: assigned sides open at their stored
   * level, unassigned sides close to 0.
   */
  setManualFxAssign(kind: RecipeEffectKind, assign: ManualFxAssign): void {
    const state = this.manualFxState(kind);
    state.assign = assign;
    this.writeManualFxSend(
      kind,
      "A",
      assign === "A" || assign === "both" ? state.levels.A : 0,
    );
    this.writeManualFxSend(
      kind,
      "B",
      assign === "B" || assign === "both" ? state.levels.B : 0,
    );
  }

  /**
   * Sets one side's manual send level (remembered even while the
   * side is unassigned). Sending on an unassigned side assigns it:
   * no assign becomes that side, the other side alone becomes both.
   */
  setManualFxSend(
    kind: RecipeEffectKind,
    side: "A" | "B",
    level: number,
  ): void {
    const state = this.manualFxState(kind);
    const clamped = Math.min(1, Math.max(0, level));
    state.levels[side] = clamped;
    if (state.assign !== "both" && state.assign !== side) {
      state.assign = state.assign === null ? side : "both";
    }
    this.writeManualFxSend(kind, side, clamped);
  }

  /**
   * The one writer behind the manual FX stage. For "trans" there is
   * no send to write — the assign/level state is recorded by the
   * callers and nothing reaches a node. For the send-class kinds,
   * opening a send builds the kind's network first if needed (a
   * failed build leaves the send at 0), then pins the network's wet
   * return at unity — the manual return sits at 1 and the SEND is
   * the level control — BEFORE the send opens, so there is no click.
   */
  private writeManualFxSend(
    kind: RecipeEffectKind,
    side: "A" | "B",
    level: number,
  ): void {
    if (kind === "trans") return;
    const send = this.deckSendNode(this.decks[side === "A" ? 0 : 1], kind);
    if (!send) return;
    const now = this.context.currentTime;
    if (level === 0) {
      send.gain.setValueAtTime(0, now);
      return;
    }
    let net: { wet: GainNode } | null = null;
    try {
      net = this.ensureEffectNetwork(kind);
    } catch {
      send.gain.setValueAtTime(0, now);
      return;
    }
    if (!net) {
      send.gain.setValueAtTime(0, now);
      return;
    }
    net.wet.gain.setValueAtTime(1, now);
    send.gain.setValueAtTime(level, now);
  }

  /** Builds (once) the network behind a send-class kind, via its lazy R3 builder. */
  private ensureEffectNetwork(
    kind: RecipeEffectKind,
  ): { wet: GainNode } | null {
    switch (kind) {
      case "reverb":
        return this.ensureReverb();
      case "delay":
        return this.ensureDelay();
      case "spiral":
        return this.ensureSpiral();
      case "flanger":
        return this.ensureFlanger();
      case "phaser":
        return this.ensurePhaser();
      case "distortion":
        return this.ensureDistortion();
      case "roll":
        return this.ensureRoll();
      default:
        return null;
    }
  }

  private applyManualStage(): void {
    const [a, b] = crossfadeGains(this.crossfadePosition, this.crossfaderCurve);
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
    deck.scratchGate.gain.setValueAtTime(1, now);
    deck.fxGate.gain.setValueAtTime(1, now);
    deck.reverbSend.gain.setValueAtTime(0, now);
    deck.delaySend.gain.setValueAtTime(0, now);
    deck.flangerSend.gain.setValueAtTime(0, now);
    deck.phaserSend.gain.setValueAtTime(0, now);
    deck.distortionSend.gain.setValueAtTime(0, now);
    deck.spiralSend.gain.setValueAtTime(0, now);
    deck.rollSend.gain.setValueAtTime(0, now);
    if (this.cascadeGain) {
      this.cascadeGain.gain.setValueAtTime(0, now);
    }
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
      deck.fxGate.gain.cancelScheduledValues(now);
      deck.fxGate.gain.setValueAtTime(1, now);
      for (const send of [
        deck.reverbSend,
        deck.delaySend,
        deck.flangerSend,
        deck.phaserSend,
        deck.distortionSend,
        deck.spiralSend,
        deck.rollSend,
      ]) {
        send.gain.cancelScheduledValues(now);
        send.gain.setValueAtTime(0, now);
      }
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
    // R3's effect blocks anchor the same way, so an A-side block
    // without an anchor falls back under the same rule.
    if (
      working.overlap.startAMs === null &&
      (working.loops.some((l) => l.type !== "loop" && l.side === "A") ||
        (working.effects ?? []).some((b) => b.side === "A"))
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

    // The R3 networks: built lazily for every effect this recipe
    // names — in its fx configs or in its effect blocks — then
    // retuned at the blend's start, echo-style. trans and roll
    // have no blend-start retune: trans is a gate pattern, roll's
    // parameters are its block's choreography.
    {
      const fx = working.fx;
      const blockKinds = new Set((working.effects ?? []).map((b) => b.kind));
      const needs = (kind: string, present: boolean) =>
        present || blockKinds.has(kind as never);
      if (needs("reverb", !!fx.reverb)) {
        this.ensureReverb(fx.reverb?.decaySec);
      }
      if (needs("delay", !!fx.delay)) this.ensureDelay();
      if (needs("spiral", !!fx.spiral)) this.ensureSpiral();
      if (needs("flanger", !!fx.flanger)) this.ensureFlanger();
      if (needs("phaser", !!fx.phaser)) this.ensurePhaser();
      if (needs("distortion", !!fx.distortion)) this.ensureDistortion();
      if (needs("roll", !!fx.roll)) this.ensureRoll();
      if (fx.delay && this.delayNet) {
        this.delayNet.delay.delayTime.setValueAtTime(
          fx.delay.delaySec,
          blendStart,
        );
        this.delayNet.feedback.gain.setValueAtTime(
          fx.delay.feedback,
          blendStart,
        );
        this.delayNet.wet.gain.setValueAtTime(fx.delay.wet, blendStart);
      }
      if (fx.spiral && this.spiralNet) {
        // delayTime is per-block (the sweep); only the loop's
        // character is retuned here.
        this.spiralNet.feedback.gain.setValueAtTime(
          fx.spiral.feedback,
          blendStart,
        );
        this.spiralNet.wet.gain.setValueAtTime(fx.spiral.wet, blendStart);
      }
      if (fx.flanger && this.flangerNet) {
        this.flangerNet.osc.frequency.setValueAtTime(
          fx.flanger.rateHz,
          blendStart,
        );
        this.flangerNet.depthGain.gain.setValueAtTime(
          fx.flanger.depthMs / 1000,
          blendStart,
        );
        this.flangerNet.feedback.gain.setValueAtTime(
          fx.flanger.feedback,
          blendStart,
        );
        this.flangerNet.wet.gain.setValueAtTime(fx.flanger.wet, blendStart);
      }
      if (fx.phaser && this.phaserNet) {
        this.phaserNet.osc.frequency.setValueAtTime(
          fx.phaser.rateHz,
          blendStart,
        );
        // Depth mapping (stated choice): each allpass sweeps
        // ±centre × depth × 0.75 Hz around its centre — three
        // quarters of the centre at full depth, so the top
        // allpass sweeps widest in absolute terms, as a phaser's
        // notches should.
        for (let i = 0; i < this.phaserNet.filters.length; i += 1) {
          this.phaserNet.depthGains[i].gain.setValueAtTime(
            this.phaserNet.centres[i] * fx.phaser.depth * 0.75,
            blendStart,
          );
        }
        this.phaserNet.wet.gain.setValueAtTime(fx.phaser.wet, blendStart);
      }
      if (fx.reverb && this.reverbNet) {
        this.reverbNet.wet.gain.setValueAtTime(fx.reverb.wet, blendStart);
      }
      if (fx.distortion && this.distortionNet) {
        // Property sets are not automation; the sends rest at 0
        // when unused, so a standing curve is inaudible.
        this.distortionNet.shaper.curve = makeDistortionCurve(
          fx.distortion.amount,
        );
        this.distortionNet.drive.gain.setValueAtTime(
          1 + fx.distortion.amount * 12,
          blendStart,
        );
        this.distortionNet.wet.gain.setValueAtTime(
          fx.distortion.wet,
          blendStart,
        );
      }
      if (this.delayNet || this.reverbNet) {
        this.cascadeGain.gain.setValueAtTime(
          fx.chainDelayIntoReverb ? 0.6 : 0,
          blendStart,
        );
      }
      // Effect blocks are scheduled now, with the decks and the
      // blend's geometry in hand (the helper reads both decks).
      this.scheduleEffectBlocks(working, outgoing, incoming, blendStart);
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
      const bScratches = bMoves.filter(isScratchMove);
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
      } else if (bScratches.length > 0) {
        // A scratch on the incoming deck takes the rate control
        // for its window, as a stop move does — but where a stop
        // ends the deck, a scratch RETURNS it: the written curve
        // governs until the window, the hand governs inside it,
        // and at the window's end the curve is rejoined at its own
        // value there and re-scheduled for the remainder. The gate
        // plays the technique's fader pattern on the deck's
        // scratch gate — a parameter nothing else writes, so the
        // gate and the blend can never fight over one control.
        // Windows run in time order; a nudge outside every scratch
        // window is still performed as written, and one inside a
        // window is subsumed (the hand owns its window outright).
        // Authoring never mixes these; a recipe carrying both gets
        // both, each in its own time.
        scheduleEvents(rate, a.rateB, blendStart);
        const windows = [...bScratches]
          .sort((x, y) => moveStartCtx(x) - moveStartCtx(y))
          .map((move) => ({
            move,
            start: moveStartCtx(move),
            end: moveStartCtx(move) + moveDurationSec(move),
          }));
        for (const w of windows) {
          const startOffMs = (w.start - blendStart) * 1000;
          const endOffMs = (w.end - blendStart) * 1000;
          rate.cancelScheduledValues(w.start);
          const base = automationValueAt(a.rateB, startOffMs);
          rate.setValueAtTime(base, w.start);
          scheduleScratchHand(
            rate,
            w.move,
            w.start,
            w.end - w.start,
            base,
            working.overlap.bpmB,
          );
          scheduleScratchGate(
            incoming.scratchGate.gain,
            w.move,
            w.start,
            w.end - w.start,
          );
          const endValue = automationValueAt(a.rateB, endOffMs);
          rate.setValueAtTime(endValue, w.end);
          const tail = a.rateB.points.filter((p) => p.atMs > endOffMs);
          if (tail.length > 0) {
            scheduleEvents(
              rate,
              {
                ...a.rateB,
                points: [{ atMs: endOffMs, value: endValue }, ...tail],
              },
              blendStart,
            );
          }
        }
        for (const move of bNudges) {
          const start = moveStartCtx(move);
          const durSec = moveDurationSec(move);
          if (windows.some((w) => start < w.end && start + durSec > w.start)) {
            continue;
          }
          scheduleNudge(
            rate,
            start,
            durSec,
            automationValueAt(a.rateB, (start - blendStart) * 1000),
            move.bend ?? 1,
          );
        }
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
        } else if (isScratchMove(move)) {
          // A scratch on the outgoing deck — the scratch-out over
          // its tail. A's rate is a written constant, so there is
          // no curve to take over or rejoin: the hand performs from
          // it and returns to it, the gate plays on A's own scratch
          // gate, and the deck's stop waits for the window to
          // finish sounding, as it does for a stop move.
          scheduleScratchHand(
            outRate,
            move,
            startCtx,
            durSec,
            working.overlap.rateA,
            working.overlap.bpmA,
          );
          scheduleScratchGate(
            outgoing.scratchGate.gain,
            move,
            startCtx,
            durSec,
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
    incoming.scratchGate.gain.setValueAtTime(1, start);
    incoming.fxGate.gain.setValueAtTime(1, start);
    incoming.reverbSend.gain.setValueAtTime(0, start);
    incoming.delaySend.gain.setValueAtTime(0, start);
    incoming.flangerSend.gain.setValueAtTime(0, start);
    incoming.phaserSend.gain.setValueAtTime(0, start);
    incoming.distortionSend.gain.setValueAtTime(0, start);
    incoming.spiralSend.gain.setValueAtTime(0, start);
    incoming.rollSend.gain.setValueAtTime(0, start);
    incoming.play(start, Math.max(0, startBSec), 1);
    outgoing.gain.gain.cancelScheduledValues(start);
    outgoing.gain.gain.setValueAtTime(0, start);
    outgoing.stop(start + 0.05);
    this.current = 1 - this.current;
    return { blendStartCtxTime: start, blendEndCtxTime: start };
  }
}
