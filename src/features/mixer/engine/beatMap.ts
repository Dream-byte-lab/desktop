// The beat map of one track: everything the mixer needs to know about where
// the beats, bars and phrases fall. Produced by the analyser from the real
// audio; written down here as plain data so the planner and the decks can be
// tested without any audio at all.
//
// Version 2 (Step 5, analysis v2): beside the summary tempo, the map now
// carries a bending beat grid (built by gridTrack.ts): a set of anchors —
// beats whose true position was read off a strong onset — with straight-line
// interpolation between them. A track whose tempo drifts is followed by its
// grid instead of being forced onto one rigid spacing. The v1 fields keep
// their exact meanings (bpm is the whole-track summary, firstBeatSec the
// rigid grid's origin), and every lookup helper below falls back to the v1
// constant-tempo arithmetic when a map carries no grid, so hand-built maps
// in older tests and fixtures behave exactly as they always did.

export interface BeatGridAnchor {
  /** Beat index, counted from the first downbeat (beat 0). */
  beat: number;
  /** Track time, in seconds, where this beat actually falls. */
  timeSec: number;
  /** 0..1 — how decisively the onset evidence supported this anchor. */
  confidence: number;
}

export interface BeatGridSection {
  /** First beat of the span (inclusive). */
  startBeat: number;
  /** Last beat of the span (exclusive). */
  endBeat: number;
  /** Local tempo across the span, from the anchors it contains. */
  bpm: number;
  /** 0..1 — anchor agreement across the span. Weak sections are marked, not hidden. */
  confidence: number;
}

export interface BeatGrid {
  /** Anchors in ascending beat order, times strictly increasing. */
  anchors: BeatGridAnchor[];
  /** Fixed-width spans (16 beats) summarising local tempo and confidence. */
  sections: BeatGridSection[];
  /** 0..1 — beat-weighted mean of the section confidences. */
  confidence: number;
}

export interface BeatMap {
  /** Tempo in beats per minute — the whole-track summary. */
  bpm: number;
  /** Track time, in seconds, of beat 0 — a downbeat. */
  firstBeatSec: number;
  /** Beats in a bar; almost always 4 in dance music. */
  beatsPerBar: number;
  /** Total track length in seconds. */
  durationSec: number;
  /** The bending grid, when the analyser built one (analysis v2). */
  grid?: BeatGrid;
}

export function secondsPerBeat(bpm: number): number {
  return 60 / bpm;
}

/** The grid section covering a beat, when the map has sections. */
function sectionAtBeat(map: BeatMap, beat: number): BeatGridSection | null {
  const sections = map.grid?.sections;
  if (!sections || sections.length === 0) return null;
  for (const section of sections) {
    if (beat >= section.startBeat && beat < section.endBeat) return section;
  }
  return beat < sections[0].startBeat
    ? sections[0]
    : sections[sections.length - 1];
}

/** How many beats have passed since beat 0 at a track time (can be fractional). */
export function beatsAtTime(map: BeatMap, timeSec: number): number {
  const anchors = map.grid?.anchors;
  if (!anchors || anchors.length === 0) {
    return (timeSec - map.firstBeatSec) / secondsPerBeat(map.bpm);
  }
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (timeSec <= first.timeSec) {
    const section = sectionAtBeat(map, first.beat);
    const spb = secondsPerBeat(section ? section.bpm : map.bpm);
    return first.beat - (first.timeSec - timeSec) / spb;
  }
  if (timeSec >= last.timeSec) {
    const section = sectionAtBeat(map, last.beat);
    const spb = secondsPerBeat(section ? section.bpm : map.bpm);
    return last.beat + (timeSec - last.timeSec) / spb;
  }
  // Binary search for the anchor pair straddling this time.
  let lo = 0;
  let hi = anchors.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].timeSec <= timeSec) lo = mid;
    else hi = mid;
  }
  const a = anchors[lo];
  const b = anchors[hi];
  const span = b.timeSec - a.timeSec;
  if (span <= 0) return a.beat;
  return a.beat + ((timeSec - a.timeSec) / span) * (b.beat - a.beat);
}

/** Track time at which a beat index falls. */
export function timeAtBeat(map: BeatMap, beat: number): number {
  const anchors = map.grid?.anchors;
  if (!anchors || anchors.length === 0) {
    return map.firstBeatSec + beat * secondsPerBeat(map.bpm);
  }
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (beat <= first.beat) {
    const section = sectionAtBeat(map, first.beat);
    const spb = secondsPerBeat(section ? section.bpm : map.bpm);
    return first.timeSec - (first.beat - beat) * spb;
  }
  if (beat >= last.beat) {
    const section = sectionAtBeat(map, last.beat);
    const spb = secondsPerBeat(section ? section.bpm : map.bpm);
    return last.timeSec + (beat - last.beat) * spb;
  }
  let lo = 0;
  let hi = anchors.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid].beat <= beat) lo = mid;
    else hi = mid;
  }
  const a = anchors[lo];
  const b = anchors[hi];
  const span = b.beat - a.beat;
  if (span <= 0) return a.timeSec;
  return a.timeSec + ((beat - a.beat) / span) * (b.timeSec - a.timeSec);
}

/** Beats in one phrase: a run of bars, 4 bars unless told otherwise. */
export function phraseBeats(map: BeatMap, barsPerPhrase = 4): number {
  return map.beatsPerBar * barsPerPhrase;
}
