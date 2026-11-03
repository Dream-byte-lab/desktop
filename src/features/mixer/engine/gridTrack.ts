import {
  secondsPerBeat,
  type BeatGrid,
  type BeatGridAnchor,
  type BeatGridSection,
} from "./beatMap";

// The bending beat grid (Step 5, analysis v2).
//
// Version one's grid was a single phase offset plus a constant
// seconds-per-beat for the whole track: any tempo drift accumulated
// unchecked, and every phrase/drop/entry calculation inherited the
// error. This module builds the replacement: it WALKS the track beat
// by beat, predicting each beat from the recent local tempo and
// snapping the prediction to the strongest nearby onset. Anchors are
// the beats it could actually hear; between anchors the grid
// interpolates, so a drifting track is followed instead of forced,
// and a weak stretch is bridged by its neighbours instead of invented.
//
// Honesty is built into the output: every anchor carries a confidence
// (how decisive the onset evidence was), every 16-beat section
// summarises its local tempo and its anchor agreement, and sections
// with weak grids are marked — never silently treated as certain.

export interface BeatGridInput {
  /** Onset envelope: one entry per analysis frame (positive energy jumps). */
  onsets: Float32Array;
  framesPerSecond: number;
  /** Track time of beat 0 (the rigid grid's downbeat origin). */
  firstBeatSec: number;
  /** Whole-track summary tempo — the rigid reference and starting tempo. */
  bpm: number;
  durationSec: number;
}

/**
 * The leash on the LOCAL tempo, as a ratio against the summary bpm:
 * the walk may bend the tempo within this band, but a "grid" that
 * claims 90 bpm inside a 124 bpm track has been captured by some
 * other pattern, not drifted. Note what the leash is NOT: it is not
 * a clamp on absolute position against the rigid grid. A linear
 * tempo ramp deviates from its own average-tempo line by up to a
 * full beat at mid-track, so a positional clamp makes drift
 * unfollowable by construction — the walk follows the ramp because
 * each step is small, and the tempo band is what keeps a long walk
 * honest.
 */
const MIN_LOCAL_TEMPO_RATIO = 0.8;
const MAX_LOCAL_TEMPO_RATIO = 1.25;
/** Search half-window around each prediction, in beats. */
const SEARCH_HALF_WINDOW_BEATS = 0.4;
/** Normalised onset strength below which a beat is not anchored. */
const MIN_ANCHOR_STRENGTH = 0.12;
/** Confidence credited to an unanchored beat inside a section its neighbours anchor. */
const BRIDGED_CONFIDENCE = 0.3;
/** Confidence credited to an unanchored beat in a section with almost no anchors. */
const ORPHAN_CONFIDENCE = 0.15;
const SECTION_BEATS = 16;

function percentile(values: Float32Array, p: number): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * sorted.length)),
  );
  return sorted[idx];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function buildBeatGrid(input: BeatGridInput): BeatGrid {
  const { onsets, framesPerSecond, firstBeatSec, bpm, durationSec } = input;
  const spbRigid = secondsPerBeat(bpm);
  const totalBeats = Math.floor((durationSec - firstBeatSec) / spbRigid);

  const fallbackSection: BeatGridSection = {
    startBeat: 0,
    endBeat: Math.max(1, totalBeats),
    bpm,
    confidence: 0,
  };
  if (totalBeats < 4 || onsets.length === 0) {
    return {
      anchors: [{ beat: 0, timeSec: firstBeatSec, confidence: 0 }],
      sections: [fallbackSection],
      confidence: 0,
    };
  }

  // The strength a beat's onset must rival to count as "clearly heard":
  // the track's own strong onset EVENTS (90th percentile of the nonzero
  // entries). Percentiling the raw envelope instead would read the
  // silence between events on sparse material — a click track's onsets
  // are ~95% zeros, its 90th percentile is zero, and no beat would
  // ever qualify as strong.
  const onsetEvents: number[] = [];
  for (let i = 0; i < onsets.length; i += 1) {
    if (onsets[i] > 0) onsetEvents.push(onsets[i]);
  }
  const strongOnset =
    onsetEvents.length > 0
      ? percentile(Float32Array.from(onsetEvents), 0.9)
      : 0;

  const anchors: BeatGridAnchor[] = [];
  const recentIntervals: number[] = [];
  let spbLocal = spbRigid;

  for (let beat = 0; beat < totalBeats; beat += 1) {
    const rigidTime = firstBeatSec + beat * spbRigid;
    const last = anchors[anchors.length - 1];
    // Predict from the last anchor at the recent local tempo. Each
    // step is small and onset-checked; that — plus the tempo band
    // enforced at acceptance below — is the whole leash.
    const predicted = last
      ? last.timeSec + (beat - last.beat) * spbLocal
      : rigidTime;

    if (strongOnset <= 0) break;
    const centreFrame = predicted * framesPerSecond;
    const halfWindow = SEARCH_HALF_WINDOW_BEATS * spbLocal * framesPerSecond;
    const from = Math.max(0, Math.floor(centreFrame - halfWindow));
    const to = Math.min(onsets.length - 1, Math.ceil(centreFrame + halfWindow));
    let bestFrame = -1;
    let bestScore = 0;
    for (let f = from; f <= to; f += 1) {
      const proximity = 1 - Math.abs(f - centreFrame) / (halfWindow + 1);
      const score = onsets[f] * proximity;
      if (score > bestScore) {
        bestScore = score;
        bestFrame = f;
      }
    }
    if (bestFrame < 0) continue;
    const strength = onsets[bestFrame] / strongOnset;
    if (strength < MIN_ANCHOR_STRENGTH) continue;
    const timeSec = bestFrame / framesPerSecond;
    if (last && timeSec <= last.timeSec + 0.25 * spbLocal) continue;
    // The tempo band: the interval this anchor implies, and the
    // running local tempo it would produce, must both stay within
    // the band around the summary tempo.
    if (last) {
      const impliedSpb = (timeSec - last.timeSec) / (beat - last.beat);
      const impliedBpm = 60 / impliedSpb;
      if (
        impliedBpm < bpm * MIN_LOCAL_TEMPO_RATIO ||
        impliedBpm > bpm * MAX_LOCAL_TEMPO_RATIO
      ) {
        continue;
      }
    }

    const distance = Math.abs(bestFrame - centreFrame) / (halfWindow + 1);
    const confidence = Math.min(1, strength) * (1 - 0.5 * distance);
    const anchor: BeatGridAnchor = { beat, timeSec, confidence };
    if (last) {
      recentIntervals.push((timeSec - last.timeSec) / (beat - last.beat));
      if (recentIntervals.length > 8) recentIntervals.shift();
      const med = median(recentIntervals);
      if (med > 0) spbLocal = med;
    }
    anchors.push(anchor);
  }

  if (anchors.length === 0) {
    return {
      anchors: [{ beat: 0, timeSec: firstBeatSec, confidence: 0 }],
      sections: [fallbackSection],
      confidence: 0,
    };
  }

  // Sections: fixed 16-beat spans; local tempo from the anchors they
  // hold, confidence from how much of the span is actually anchored.
  const sections: BeatGridSection[] = [];
  let previousBpm = bpm;
  for (let start = 0; start < totalBeats; start += SECTION_BEATS) {
    const end = Math.min(totalBeats, start + SECTION_BEATS);
    const inside = anchors.filter((a) => a.beat >= start && a.beat < end);
    let sectionBpm = previousBpm;
    if (inside.length >= 2) {
      const firstA = inside[0];
      const lastA = inside[inside.length - 1];
      const dBeats = lastA.beat - firstA.beat;
      const dTime = lastA.timeSec - firstA.timeSec;
      if (dBeats >= 4 && dTime > 0) sectionBpm = (60 * dBeats) / dTime;
    }
    previousBpm = sectionBpm;
    let confidenceSum = 0;
    for (let b = start; b < end; b += 1) {
      const anchor = inside.find((a) => a.beat === b);
      if (anchor) confidenceSum += anchor.confidence;
      else
        confidenceSum +=
          inside.length >= 2 ? BRIDGED_CONFIDENCE : ORPHAN_CONFIDENCE;
    }
    sections.push({
      startBeat: start,
      endBeat: end,
      bpm: sectionBpm,
      confidence: confidenceSum / Math.max(1, end - start),
    });
  }

  let weighted = 0;
  let beatsTotal = 0;
  for (const section of sections) {
    const beats = section.endBeat - section.startBeat;
    weighted += section.confidence * beats;
    beatsTotal += beats;
  }

  return {
    anchors,
    sections,
    confidence: beatsTotal > 0 ? weighted / beatsTotal : 0,
  };
}
