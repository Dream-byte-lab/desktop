// Pure data layer for the REV7-style DJ stage.
//
// Everything in here is derived from a TrackAnalysis (or, for the
// activity feed, a plain snapshot of session state) and nothing else:
// no invented times, no claimed DJ moves the data cannot prove. The
// stage components render what these functions return verbatim.

import type { TrackAnalysis } from "../../engine/analyseTrack";
import type { StageCurrentMove } from "./stageSnapshot";

export interface StageCue {
  id: string;
  timeSec: number;
  label: string;
  kind: "intro" | "section" | "drop" | "outro" | "user";
}

export interface WaveBar {
  level: number;
  vocal: boolean;
}

export interface SectionSpan {
  kind: string;
  startFrac: number;
  endFrac: number;
  label: string;
}

export interface ActivitySnapshot {
  running: boolean;
  paused: boolean;
  blending: boolean;
  degraded: boolean;
  plainCutCount: number;
  currentTitle: string | null;
  nextTitle: string | null;
  nextPrepared: boolean;
  openRequestCount: number;
  endReason: string | null;
}

export interface ActivityLine {
  tone: "live" | "prep" | "warn" | "idle";
  text: string;
}

function capitalise(word: string): string {
  if (word.length === 0) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// Dedupe priority: a lower number wins when two candidates land
// within the dedupe window of each other.
const CUE_PRIORITY: Record<StageCue["kind"], number> = {
  drop: 0,
  intro: 1,
  outro: 1,
  section: 2,
  user: 3,
};

const CUE_DEDUPE_WINDOW_SEC = 2.0;
const MAX_LANDMARK_CUES = 8;

interface CueCandidate {
  timeSec: number;
  label: string;
  kind: StageCue["kind"];
}

export function landmarkCues(analysis: TrackAnalysis): StageCue[] {
  const candidates: CueCandidate[] = [];

  if (analysis.intro != null && Number.isFinite(analysis.intro.endSec)) {
    candidates.push({
      timeSec: analysis.intro.endSec,
      label: "Intro end",
      kind: "intro",
    });
  }

  if (analysis.sections) {
    for (const section of analysis.sections) {
      // A section starting at 0 is the track's opening, not a landmark.
      if (!(section.startSec > 0)) continue;
      if (!Number.isFinite(section.startSec)) continue;
      if (section.kind === "drop") {
        candidates.push({
          timeSec: section.startSec,
          label: "Drop",
          kind: "drop",
        });
      } else {
        candidates.push({
          timeSec: section.startSec,
          label: capitalise(section.kind),
          kind: "section",
        });
      }
    }
  }

  // analysis.drops is already strongest first; that order is the
  // candidates' natural order before the time sort below.
  for (const drop of analysis.drops ?? []) {
    if (!Number.isFinite(drop.timeSec)) continue;
    candidates.push({ timeSec: drop.timeSec, label: "Drop", kind: "drop" });
  }

  if (analysis.outro != null && Number.isFinite(analysis.outro.startSec)) {
    candidates.push({
      timeSec: analysis.outro.startSec,
      label: "Outro",
      kind: "outro",
    });
  }

  // Sort by time; for candidates at the exact same time, the higher
  // dedupe priority is considered first.
  const sorted = [...candidates].sort((a, z) => {
    if (a.timeSec !== z.timeSec) return a.timeSec - z.timeSec;
    return CUE_PRIORITY[a.kind] - CUE_PRIORITY[z.kind];
  });

  const kept: CueCandidate[] = [];
  for (const candidate of sorted) {
    const conflictIdx = kept.findIndex(
      (k) => Math.abs(k.timeSec - candidate.timeSec) <= CUE_DEDUPE_WINDOW_SEC,
    );
    if (conflictIdx < 0) {
      kept.push(candidate);
      continue;
    }
    const conflict = kept[conflictIdx];
    if (CUE_PRIORITY[candidate.kind] < CUE_PRIORITY[conflict.kind]) {
      // The newcomer outranks the cue already kept at (nearly) this
      // time — it replaces it. Only replace when the newcomer does
      // not also collide with a different kept cue it does not
      // outrank; in the rare multi-collision case the earliest kept
      // cue stands.
      const otherConflict = kept.some(
        (k, idx) =>
          idx !== conflictIdx &&
          Math.abs(k.timeSec - candidate.timeSec) <= CUE_DEDUPE_WINDOW_SEC,
      );
      if (!otherConflict) {
        kept[conflictIdx] = candidate;
      }
    }
    // Otherwise the candidate is a duplicate of an equal/higher
    // priority cue and is dropped.
  }

  kept.sort((a, z) => a.timeSec - z.timeSec);

  return kept.slice(0, MAX_LANDMARK_CUES).map((candidate) => ({
    id: `${candidate.kind}-${Math.round(candidate.timeSec * 10)}`,
    timeSec: candidate.timeSec,
    label: candidate.label,
    kind: candidate.kind,
  }));
}

function vocalAtTime(analysis: TrackAnalysis, timeSec: number): boolean {
  for (const range of analysis.vocalRanges ?? []) {
    if (timeSec >= range.startSec && timeSec < range.endSec) return true;
  }

  const curve = analysis.vocalActivity;
  if (curve && curve.points.length > 0) {
    // The point covering this time: the last point that starts at or
    // before it, or the first point when the time precedes them all.
    let covering = curve.points[0];
    for (const point of curve.points) {
      if (point.timeSec <= timeSec) covering = point;
      else break;
    }
    if (covering.activity >= 0.5) return true;
  }

  return false;
}

export function waveformBars(
  analysis: TrackAnalysis,
  barCount: number,
): WaveBar[] {
  if (!Number.isFinite(barCount) || barCount <= 0) return [];
  const count = Math.floor(barCount);
  if (count <= 0) return [];

  const durationSec = analysis.beatMap?.durationSec ?? 0;

  const zeroBars = (): WaveBar[] =>
    Array.from({ length: count }, () => ({ level: 0, vocal: false }));

  if (!Number.isFinite(durationSec) || durationSec <= 0) return zeroBars();

  const centreTime = (barIdx: number): number =>
    ((barIdx + 0.5) / count) * durationSec;

  const bucketIndex = (timeSec: number): number => {
    const idx = Math.floor((timeSec / durationSec) * count);
    return Math.min(count - 1, Math.max(0, idx));
  };

  const contour = analysis.energyContour;
  const curve = analysis.energyCurve;

  let levels: number[] | null = null;

  if (contour && contour.length > 0) {
    let maxRms = 0;
    for (const bin of contour) {
      if (Number.isFinite(bin.rms) && bin.rms > maxRms) maxRms = bin.rms;
    }
    levels = new Array<number>(count).fill(0);
    if (maxRms > 0) {
      for (const bin of contour) {
        if (!Number.isFinite(bin.timeSec) || !Number.isFinite(bin.rms)) {
          continue;
        }
        const idx = bucketIndex(bin.timeSec);
        const normalised = bin.rms / maxRms;
        if (normalised > levels[idx]) levels[idx] = normalised;
      }
    }
  } else if (curve && curve.length > 0) {
    levels = new Array<number>(count).fill(0);
    for (const point of curve) {
      if (!Number.isFinite(point.timeSec) || !Number.isFinite(point.energy)) {
        continue;
      }
      const idx = bucketIndex(point.timeSec);
      const level = Math.min(1, Math.max(0, point.energy));
      if (level > levels[idx]) levels[idx] = level;
    }
  }

  if (levels === null) return zeroBars();

  return levels.map((level, idx) => ({
    level,
    vocal: vocalAtTime(analysis, centreTime(idx)),
  }));
}

export function sectionSpans(analysis: TrackAnalysis): SectionSpan[] {
  const sections = analysis.sections;
  if (!sections || sections.length === 0) return [];

  const durationSec = analysis.beatMap?.durationSec ?? 0;
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];

  const spans: SectionSpan[] = [];
  for (const section of sections) {
    if (section.endSec <= section.startSec) continue;
    if (
      !Number.isFinite(section.startSec) ||
      !Number.isFinite(section.endSec)
    ) {
      continue;
    }
    spans.push({
      kind: section.kind,
      startFrac: Math.min(1, Math.max(0, section.startSec / durationSec)),
      endFrac: Math.min(1, Math.max(0, section.endSec / durationSec)),
      label: capitalise(section.kind),
    });
  }
  return spans;
}

const END_REASON_TEXT: Record<string, string> = {
  "queue-exhausted": "Set ended — the queue ran out",
  "start-no-playable": "Set ended — nothing playable could be prepared",
  "user-stop": "DJ stopped",
  replaced: "Set replaced by a new one",
};

export function activityLines(s: ActivitySnapshot): ActivityLine[] {
  const lines: ActivityLine[] = [];

  if (!s.running) {
    if (s.endReason) {
      lines.push({
        tone: "idle",
        text: END_REASON_TEXT[s.endReason] ?? `Set ended (${s.endReason})`,
      });
    } else {
      lines.push({ tone: "idle", text: "DJ is off" });
    }
  } else if (s.paused) {
    lines.push({ tone: "live", text: "Paused — decks are holding" });
  } else if (s.blending) {
    lines.push({
      tone: "live",
      text: `Blending — ${s.currentTitle ?? "current track"} into ${s.nextTitle ?? "the next track"}`,
    });
  } else if (s.nextTitle && !s.nextPrepared) {
    lines.push({
      tone: "prep",
      text: `Preparing incoming track — ${s.nextTitle}`,
    });
  } else if (s.nextTitle && s.nextPrepared) {
    lines.push({
      tone: "live",
      text: `Performing — ${s.currentTitle ?? "current track"}`,
    });
    if (s.openRequestCount === 1) {
      lines.push({
        tone: "prep",
        text: "1 guest request waiting for its moment",
      });
    } else if (s.openRequestCount > 1) {
      lines.push({
        tone: "prep",
        text: `${s.openRequestCount} guest requests waiting for a moment`,
      });
    }
  } else if (!s.nextTitle) {
    lines.push({
      tone: "live",
      text: `Performing — ${s.currentTitle ?? "current track"} (last in queue)`,
    });
  }

  if (s.degraded) {
    lines.push({
      tone: "warn",
      text:
        s.plainCutCount === 1
          ? "Mixing degraded — 1 plain cut so far"
          : `Mixing degraded — ${s.plainCutCount} plain cuts so far`,
    });
  }

  return lines.slice(0, 3);
}

/**
 * The deck role line (Interface Build 6, closing the display half
 * of HD-4's standby-truth gap). The standby deck's panel shows the
 * queue's next track — it must not claim that track is loaded on
 * the deck, because the session's preparation walk can land on a
 * later track (see the report's seam requests). What the UI CAN
 * say truthfully: during a blend the non-playing deck is sounding
 * its half of the join, so it is the incoming deck; otherwise it
 * is standby, next in queue. The playing deck is simply playing.
 */
export function deckRoleLabel(state: {
  isPlaying: boolean;
  blending: boolean;
}): string {
  if (state.isPlaying) return "Playing";
  if (state.blending) return "Incoming — blending in";
  return "Standby — next in queue";
}

export function activityLinesForStage(
  s: ActivitySnapshot,
  move: StageCurrentMove | null | undefined,
): ActivityLine[] {
  if (
    move == null ||
    move.label.trim().length === 0 ||
    !s.running ||
    s.paused
  ) {
    return activityLines(s);
  }

  const warnLines = activityLines(s).filter((line) => line.tone === "warn");

  const lines: ActivityLine[] = [
    { tone: "live", text: move.label },
    ...warnLines,
  ];

  return lines.slice(0, 3);
}
