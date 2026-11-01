// The beat map of one track: everything the mixer needs to know about where
// the beats, bars and phrases fall. Produced by the analyser from the real
// audio; written down here as plain data so the planner and the decks can be
// tested without any audio at all.

export interface BeatMap {
  /** Tempo in beats per minute. */
  bpm: number;
  /** Track time, in seconds, of beat 0 — a downbeat. */
  firstBeatSec: number;
  /** Beats in a bar; almost always 4 in dance music. */
  beatsPerBar: number;
  /** Total track length in seconds. */
  durationSec: number;
}

export function secondsPerBeat(bpm: number): number {
  return 60 / bpm;
}

/** How many beats have passed since beat 0 at a track time (can be fractional). */
export function beatsAtTime(map: BeatMap, timeSec: number): number {
  return (timeSec - map.firstBeatSec) / secondsPerBeat(map.bpm);
}

/** Track time at which a beat index falls. */
export function timeAtBeat(map: BeatMap, beat: number): number {
  return map.firstBeatSec + beat * secondsPerBeat(map.bpm);
}

/** Beats in one phrase: a run of bars, 4 bars unless told otherwise. */
export function phraseBeats(map: BeatMap, barsPerPhrase = 4): number {
  return map.beatsPerBar * barsPerPhrase;
}
