import type { TrackAnalysis } from "./analyseTrack";

// Chooses which beat of the incoming track the blend should aim at — the
// beat that must land on the phrase boundary as the blend ends.
//
// A DJ cues the next track so its drop (or the moment its main section
// starts) is what the crowd hears as the old track leaves. So: the
// earliest strong drop the analyser found, as long as enough of the
// track's intro exists before it to blend over. Without a usable drop,
// fall back to a fixed phrase-aligned beat (32, then 16), and if the
// track is too short for even that, beat 0 — the planner will shorten
// the blend or refuse, and the session falls back to a cut.

export interface EntryBeatOptions {
  /** A drop earlier than this beat leaves too little intro to blend over. */
  minDropBeat?: number;
}

export function chooseEntryBeat(
  analysis: TrackAnalysis,
  options: EntryBeatOptions = {},
): number {
  const minDropBeat = options.minDropBeat ?? 8;
  const totalBeats = Math.floor(
    (analysis.beatMap.durationSec - analysis.beatMap.firstBeatSec) /
      (60 / analysis.beatMap.bpm),
  );

  // Drops are stored strongest-first; the cue point is the *earliest*
  // usable one, so scan them all.
  let earliest: number | null = null;
  for (const drop of analysis.drops) {
    if (
      drop.beat >= minDropBeat &&
      (earliest === null || drop.beat < earliest)
    ) {
      earliest = drop.beat;
    }
  }
  if (earliest !== null) return earliest;
  if (totalBeats >= 48) return 32;
  if (totalBeats >= 24) return 16;
  return 0;
}
