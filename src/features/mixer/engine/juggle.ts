import { secondsPerBeat, timeAtBeat, type BeatMap } from "./beatMap";

// Beat juggling, as data (the revamp's crab-and-juggling plan,
// step J3): a short break of the CURRENT track, cut between two
// copies of that same track standing on the two decks. A juggle
// performance is a list of segments — each segment plays a defined
// span of the track from one deck — and the decks strictly
// alternate: that alternation is what makes the act a juggle and
// not a loop. A loop repeat merely LABELLED a juggle, and one-deck
// region alternation, are named non-goals of the plan; the
// validator below makes both mechanically unrepresentable as a
// valid performance (a single deck throughout fails the
// alternation check; a performance whose segments never change
// deck is refused, not performed).
//
// Two patterns ship in v1:
//   · repeat — every segment re-cues the SAME span of the break
//     (the classic juggle: the break, thrown back and forth), and
//     the track resumes at the break's own end, having heard the
//     break exactly once across the whole window in track time;
//   · continue — the segments walk FORWARD through consecutive
//     spans of the break, alternating decks, and the track
//     resumes where the walk ends.
// STAGGER (offset copies) is a v1 non-goal and has no
// representation here.
//
// This module is pure: expansion from a beat-grid anchor and
// validation in validateRecipe's voice (a list of problems, empty
// when the performance is sound). The executor (twoDeckMixer)
// and the session (djSession) consume performances; nothing here
// touches audio.

/** Which of the two v1 patterns a performance plays. */
export type JugglePattern = "repeat" | "continue";

/**
 * One segment of a juggle: `beats` beats of the track, played from
 * track position `startSec`, on role deck `deck` — 0 is the deck
 * the track is playing on when the juggle starts, 1 is the
 * borrowed standby deck holding the second copy.
 */
export interface JuggleSegment {
  deck: 0 | 1;
  startSec: number;
  beats: number;
}

/**
 * A complete juggle performance, ready for the executor: the
 * segments in sounding order, the break they cut, and the track
 * position playback resumes from when the window closes.
 */
export interface JugglePerformance {
  pattern: JugglePattern;
  /** Track time the break (the first segment's span) starts. */
  breakStartSec: number;
  /** Beats per segment; every segment carries the same count. */
  segmentBeats: number;
  /** The track's seconds-per-beat at authoring time. */
  secPerBeat: number;
  segments: JuggleSegment[];
  /**
   * The track position playback resumes from at the window's end:
   * the final segment's own end — the break's end for repeat, the
   * walk's end for continue. Track time heard across the window
   * equals the break's span either way; the juggle costs the set
   * no track time and skips none.
   */
  exitSec: number;
}

/** The authoring bounds of a v1 performance (the plan's J3). */
export const JUGGLE_MIN_SEGMENTS = 3;
export const JUGGLE_MAX_SEGMENTS = 5;
export const JUGGLE_MAX_TOTAL_BEATS = 8;

export interface JuggleExpansionInput {
  pattern: JugglePattern;
  /** Beat (on the track's own grid) the break starts on. */
  breakStartBeat: number;
  /** Beats per segment; defaults to 2, the shipped segment size. */
  segmentBeats?: number;
  segmentCount: number;
  /** The role deck the first segment sounds from — the playing deck. */
  firstDeck: 0 | 1;
  beatMap: BeatMap;
}

/**
 * Expands an authored juggle into a performance, grid-true: every
 * segment start and the exit are read off the track's own beat
 * map via timeAtBeat, so a drifting grid is honoured rather than
 * assumed metronomic. Segment lengths in seconds therefore vary
 * with the grid; the performance records beats, and the executor
 * derives each segment's sounding length from consecutive starts.
 */
export function expandJugglePerformance(
  input: JuggleExpansionInput,
): JugglePerformance {
  const segmentBeats = input.segmentBeats ?? 2;
  const { beatMap } = input;
  const breakStartSec = timeAtBeat(beatMap, input.breakStartBeat);
  const segments: JuggleSegment[] = [];
  for (let k = 0; k < input.segmentCount; k += 1) {
    const startBeat =
      input.pattern === "repeat"
        ? input.breakStartBeat
        : input.breakStartBeat + k * segmentBeats;
    segments.push({
      deck: (k % 2 === 0 ? input.firstDeck : 1 - input.firstDeck) as 0 | 1,
      startSec: timeAtBeat(beatMap, startBeat),
      beats: segmentBeats,
    });
  }
  const exitBeat =
    input.pattern === "repeat"
      ? input.breakStartBeat + segmentBeats
      : input.breakStartBeat + input.segmentCount * segmentBeats;
  return {
    pattern: input.pattern,
    breakStartSec,
    segmentBeats,
    secPerBeat: secondsPerBeat(beatMap.bpm),
    segments,
    exitSec: timeAtBeat(beatMap, exitBeat),
  };
}

const TIME_TOLERANCE_SEC = 1e-6;

/**
 * Structural checks that compare grid-read times against flat
 * secPerBeat arithmetic (the continue walk, the exit) tolerate
 * half a segment of grid drift: expansion reads the track's real
 * beat map, whose local tempo can bend well away from the summary
 * bpm across a segment, and this validator does not hold the map.
 * Half a segment still refuses a true gap or overlap (a segment
 * that starts a full segment-length early or late), which is the
 * failure these checks exist for. Checks whose values are exact
 * by construction (a repeat's re-cued starts, read from the same
 * timeAtBeat call) keep the tight tolerance above.
 */
function gridToleranceSec(secPerBeat: number, segmentBeats: number): number {
  return Math.max(TIME_TOLERANCE_SEC, secPerBeat * segmentBeats * 0.5);
}

/**
 * Validates a performance against the track it will sound on, in
 * validateRecipe's voice: a list of problems, empty when sound.
 * The session re-validates at performance time (the §3 double
 * validation discipline), so a performance that drifted out of
 * bounds between authoring and the act is refused, never clipped
 * into something else.
 */
export function validateJugglePerformance(
  performance: JugglePerformance,
  durationSec: number,
): string[] {
  const errors: string[] = [];
  const p = performance;
  if (p.pattern !== "repeat" && p.pattern !== "continue") {
    errors.push(`pattern ${String(p.pattern)} unsupported`);
  }
  if (!Number.isFinite(p.secPerBeat) || p.secPerBeat <= 0) {
    errors.push("secPerBeat must be a finite time > 0");
  }
  if (
    !Number.isInteger(p.segmentBeats) ||
    p.segmentBeats < 1 ||
    p.segmentBeats > JUGGLE_MAX_TOTAL_BEATS
  ) {
    errors.push(
      `segmentBeats must be a whole number of beats between 1 and ${JUGGLE_MAX_TOTAL_BEATS}`,
    );
  }
  if (!Number.isFinite(p.breakStartSec) || p.breakStartSec < 0) {
    errors.push("breakStartSec must be a finite time ≥ 0");
  }
  if (
    p.segments.length < JUGGLE_MIN_SEGMENTS ||
    p.segments.length > JUGGLE_MAX_SEGMENTS
  ) {
    errors.push(
      `a juggle is ${JUGGLE_MIN_SEGMENTS}–${JUGGLE_MAX_SEGMENTS} segments, got ${p.segments.length}`,
    );
  }
  const totalBeats = p.segments.reduce((sum, s) => sum + s.beats, 0);
  if (totalBeats > JUGGLE_MAX_TOTAL_BEATS) {
    errors.push(
      `a juggle spans at most ${JUGGLE_MAX_TOTAL_BEATS} beats, got ${totalBeats}`,
    );
  }
  p.segments.forEach((segment, i) => {
    if (segment.deck !== 0 && segment.deck !== 1) {
      errors.push(`segment ${i} names no deck`);
    }
    if (!Number.isInteger(segment.beats) || segment.beats < 1) {
      errors.push(`segment ${i} must span a whole number of beats ≥ 1`);
    }
    if (segment.beats !== p.segmentBeats) {
      errors.push(
        `segment ${i} spans ${segment.beats} beats, not the performance's ${p.segmentBeats}`,
      );
    }
    if (!Number.isFinite(segment.startSec) || segment.startSec < 0) {
      errors.push(`segment ${i} must start at a finite time ≥ 0`);
    }
    const endSec = segment.startSec + segment.beats * p.secPerBeat;
    if (Number.isFinite(endSec) && endSec > durationSec + TIME_TOLERANCE_SEC) {
      errors.push(
        `segment ${i} ends at ${endSec.toFixed(3)}s, past the track's ${durationSec.toFixed(3)}s`,
      );
    }
    if (i > 0 && segment.deck === p.segments[i - 1].deck) {
      // The mechanical non-goal: a performance that never changes
      // deck — a loop repeat wearing the juggle's name — is not a
      // juggle and is refused here, at the data layer, before any
      // executor or session code can be persuaded otherwise.
      errors.push(
        `segment ${i} stays on deck ${segment.deck}: a juggle alternates decks every segment`,
      );
    }
  });
  if (p.segments.length > 0) {
    const first = p.segments[0];
    if (Math.abs(first.startSec - p.breakStartSec) > TIME_TOLERANCE_SEC) {
      errors.push("the first segment must start at the break's start");
    }
    if (p.pattern === "repeat") {
      for (const segment of p.segments) {
        if (Math.abs(segment.startSec - p.breakStartSec) > TIME_TOLERANCE_SEC) {
          errors.push("a repeat juggle re-cues the same span every segment");
          break;
        }
      }
    }
    if (p.pattern === "continue") {
      for (let i = 1; i < p.segments.length; i += 1) {
        const expected =
          p.segments[i - 1].startSec + p.segments[i - 1].beats * p.secPerBeat;
        if (
          Math.abs(p.segments[i].startSec - expected) >
          gridToleranceSec(p.secPerBeat, p.segmentBeats)
        ) {
          errors.push(
            "a continue juggle walks forward: each segment starts where the last ended",
          );
          break;
        }
      }
    }
    const last = p.segments[p.segments.length - 1];
    const lastEnd = last.startSec + last.beats * p.secPerBeat;
    if (
      Math.abs(p.exitSec - lastEnd) >
      gridToleranceSec(p.secPerBeat, p.segmentBeats)
    ) {
      errors.push("exitSec must be the final segment's own end");
    }
  }
  if (
    !Number.isFinite(p.exitSec) ||
    p.exitSec > durationSec + TIME_TOLERANCE_SEC
  ) {
    errors.push("exitSec must land inside the track");
  }
  return errors;
}
