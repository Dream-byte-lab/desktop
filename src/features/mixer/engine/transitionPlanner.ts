import {
  beatsAtTime,
  phraseBeats,
  secondsPerBeat,
  timeAtBeat,
  type BeatMap,
} from "./beatMap";
import type { KeyEstimate } from "./detectKey";
import { keyCompatibility, type KeyCompatibility } from "./keyCompatibility";

// Plans one beatmatched blend between the track that is playing and the
// track that comes next. Pure arithmetic on beat maps — no audio, no clock —
// so every rule a DJ would apply by ear is written down and testable:
//
// - the blend starts on a phrase boundary of the outgoing track, never
//   mid-phrase, and never so soon that it cannot be scheduled safely;
// - the incoming track is tempo-matched to the outgoing one for the length
//   of the blend, and its chosen entry beat (its drop, or the first strong
//   beat of a section) lands exactly on a phrase boundary as the blend ends;
// - the bass swap happens on a bar boundary partway through the blend, so
//   only one track owns the low end at any moment;
// - after the blend, the incoming track glides back to its natural tempo.
//
// Returns null when no honest blend exists from here (the outgoing track is
// nearly over, or the incoming entry point cannot be reached) — the caller
// is then expected to fall back to a cut or an echo-out instead of forcing
// a bad mix.

export interface TransitionRequest {
  outgoing: BeatMap;
  /** Where the outgoing track is playing right now, in track seconds. */
  outgoingPositionSec: number;
  incoming: BeatMap;
  /**
   * Beat of the incoming track that must land on the phrase boundary at the
   * end of the blend — usually its drop or the first beat after its intro.
   */
  incomingEntryBeat: number;
  /** Desired blend length in beats. Defaults to 16. */
  blendBeats?: number;
  /** Bars per phrase on the outgoing track. Defaults to 4. */
  phraseBars?: number;
  /** The blend may not start sooner than this many beats from now. Defaults to 8. */
  minLeadBeats?: number;
  /**
   * Largest tempo stretch, as a fraction (0.08 = 8%), still considered a
   * comfortable beatmatch. Larger stretches are planned but flagged.
   */
  tempoTolerance?: number;
  /** Estimated keys, when the analyser produced them — used for the plan's harmonic report. */
  outgoingKey?: KeyEstimate | null;
  incomingKey?: KeyEstimate | null;
  /**
   * When true, a harmonically clashing pair gets no blend (null), so
   * the caller falls back to a cut or echo-out. Off by default: a clash
   * is reported on the plan, not treated as fatal.
   */
  requireKeyCompatibility?: boolean;
}

export interface TransitionPlan {
  /** Actual blend length in beats (may be shorter than requested). */
  blendBeats: number;
  /** Seconds from now until the incoming track starts playing. */
  startsInSec: number;
  /** Length of the overlap, in seconds. */
  blendDurationSec: number;
  /** Beat index in the outgoing track where the blend starts. */
  outgoingExitBeat: number;
  /** Beat index in the outgoing track where it stops. */
  outgoingEndBeat: number;
  /** Track time, in seconds, where the incoming track starts playing. */
  incomingStartSec: number;
  /** The incoming entry beat this plan was built around. */
  incomingEntryBeat: number;
  /** Playback rate for the incoming track during the blend. */
  incomingRate: number;
  /** How far the incoming tempo is stretched, as a fraction (0.05 = 5%). */
  tempoStretch: number;
  /** False when the stretch exceeds the comfortable tolerance. */
  tempoComfortable: boolean;
  /** Beats into the blend at which the bass swaps to the incoming track. */
  bassSwapBeatOffset: number;
  /** Seconds from now at which the bass swap happens. */
  bassSwapInSec: number;
  /** Seconds the incoming track takes to glide back to rate 1 afterwards. */
  rateReturnDurationSec: number;
  /** Harmonic fit of the pair, when both keys are known. */
  keyCompatibility: KeyCompatibility | null;
}

const MIN_BLEND_BEATS = 4;
const EPSILON = 1e-9;

export function planTransition(
  request: TransitionRequest,
): TransitionPlan | null {
  const { outgoing, incoming } = request;
  const requestedBlend = request.blendBeats ?? 16;
  const minLead = request.minLeadBeats ?? 8;
  const tolerance = request.tempoTolerance ?? 0.08;
  const bars = request.phraseBars ?? 4;

  const spbOut = secondsPerBeat(outgoing.bpm);
  const spbIn = secondsPerBeat(incoming.bpm);
  const phrase = phraseBeats(outgoing, bars);
  const nowBeat = beatsAtTime(outgoing, request.outgoingPositionSec);

  // The blend cannot run the outgoing track past its own end. Start from
  // the first phrase boundary far enough ahead of now, and walk backwards
  // a phrase at a time while the blend would overrun the track.
  let exitBeat = Math.ceil((nowBeat + minLead - EPSILON) / phrase) * phrase;
  let blend = requestedBlend;
  while (
    exitBeat > nowBeat &&
    timeAtBeat(outgoing, exitBeat + blend) > outgoing.durationSec + EPSILON
  ) {
    exitBeat -= phrase;
  }
  if (timeAtBeat(outgoing, exitBeat + blend) > outgoing.durationSec + EPSILON) {
    return null;
  }
  if (exitBeat - nowBeat < 1) return null;

  // Walking back `blend` beats from the entry beat must not land before
  // the start of the incoming file. Those beats are measured in the
  // incoming track's own time — at the matched playback rate they take
  // exactly the blend's wall-clock length, but the position inside the
  // file is counted with the incoming track's own seconds-per-beat.
  const incomingStartSec = () =>
    incoming.firstBeatSec + (request.incomingEntryBeat - blend) * spbIn;
  while (blend > MIN_BLEND_BEATS && incomingStartSec() < 0) {
    blend -= 1;
  }
  if (incomingStartSec() < -EPSILON) return null;

  // The entry beat itself must exist inside the incoming track.
  const entryTimeSec = timeAtBeat(incoming, request.incomingEntryBeat);
  if (entryTimeSec >= incoming.durationSec) return null;

  const incomingRate = outgoing.bpm / incoming.bpm;
  const tempoStretch = Math.abs(incomingRate - 1);

  // Bass swap on the bar boundary nearest the middle of the blend.
  const halfBars = Math.floor(blend / 2 / outgoing.beatsPerBar);
  const bassSwapBeatOffset = Math.max(
    outgoing.beatsPerBar,
    halfBars * outgoing.beatsPerBar,
  );

  const startsInSec =
    timeAtBeat(outgoing, exitBeat) - request.outgoingPositionSec;
  const blendDurationSec = blend * spbOut;

  const keyFit = keyCompatibility(
    request.outgoingKey ?? null,
    request.incomingKey ?? null,
  );
  if (request.requireKeyCompatibility && keyFit && !keyFit.compatible) {
    return null;
  }

  return {
    blendBeats: blend,
    startsInSec,
    blendDurationSec,
    outgoingExitBeat: exitBeat,
    outgoingEndBeat: exitBeat + blend,
    incomingStartSec: Math.max(0, incomingStartSec()),
    incomingEntryBeat: request.incomingEntryBeat,
    incomingRate,
    tempoStretch,
    tempoComfortable: tempoStretch <= tolerance + EPSILON,
    bassSwapBeatOffset,
    bassSwapInSec: startsInSec + bassSwapBeatOffset * spbOut,
    rateReturnDurationSec: phrase * secondsPerBeat(incoming.bpm),
    keyCompatibility: keyFit,
  };
}
