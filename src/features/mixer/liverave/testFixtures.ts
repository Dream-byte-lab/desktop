// testFixtures.ts — hand-built TrackReads for the Wave 2 tests.
//
// Every fixture is specified in BEATS (sections, drops and vocal
// zones all start on downbeats), then rendered into a TrackRead with
// an exact grid, a 250 ms energy contour and 4-beat vocal windows.
// That keeps phrase alignment honest: authors see the same clean
// structure a good analyser would report for a tidy recording.
//
// This file is test support only — no production module imports it.

import {
  buildTrackFacts,
  type SectionKind,
  type TrackFacts,
  type TrackRead,
  type TrackReadKey,
} from "./facts";

export interface FixtureSection {
  kind: SectionKind;
  fromBeat: number;
  toBeat: number;
  energy: number;
}

export interface FixtureSpec {
  bpm: number;
  totalBeats: number;
  key: TrackReadKey;
  tempoConfidence: number;
  gridConfidence: number;
  sections: FixtureSection[];
  drops: { atBeat: number; strength: number }[];
  /** Graded vocal activity at a beat. */
  vocalAtBeat: (beat: number) => number;
  /** Beat ranges whose energy contour is spiky (transient-rich). */
  transientZones: [number, number][];
}

// 125 ms bins: fine enough that the per-beat spike pattern is
// sampled in every beat (a 250 ms step aliases against ~480 ms
// beats and whole windows can miss every spike).
const CONTOUR_STEP_MS = 125;
const VOCAL_WINDOW_BEATS = 4;

export function buildFixtureRead(spec: FixtureSpec): TrackRead {
  const msPerBeat = 60_000 / spec.bpm;
  const durationMs = spec.totalBeats * msPerBeat;
  const durationSec = durationMs / 1000;

  const beatsMs: number[] = [];
  for (let b = 0; b <= spec.totalBeats; b += 1) beatsMs.push(b * msPerBeat);
  const downbeatsMs: number[] = [];
  for (let b = 0; b <= spec.totalBeats; b += 4) {
    downbeatsMs.push(b * msPerBeat);
  }

  const sectionEnergyAtBeat = (beat: number): number => {
    for (const s of spec.sections) {
      if (beat >= s.fromBeat && beat < s.toBeat) return s.energy;
    }
    return 0.05;
  };
  const inTransientZone = (beat: number): boolean =>
    spec.transientZones.some(([from, to]) => beat >= from && beat < to);

  const energyContour: { atMs: number; rms: number }[] = [];
  for (let atMs = 0; atMs < durationMs; atMs += CONTOUR_STEP_MS) {
    const beat = atMs / msPerBeat;
    const base = sectionEnergyAtBeat(beat);
    let rms = base;
    if (inTransientZone(beat)) {
      // One sharp spike per beat on a low bed: peak/mean ≈ 2.5.
      const phase = beat - Math.floor(beat);
      rms = base * (phase < 0.25 ? 2.8 : 0.55);
    }
    energyContour.push({ atMs, rms });
  }
  const loudnessRms =
    energyContour.reduce((sum, bin) => sum + bin.rms, 0) /
    Math.max(1, energyContour.length);

  const energyCurvePerSec: number[] = [];
  for (let sec = 0; sec < Math.ceil(durationSec); sec += 1) {
    energyCurvePerSec.push(sectionEnergyAtBeat((sec * 1000) / msPerBeat));
  }

  const vocalActivity: TrackRead["vocalActivity"] = [];
  for (let b = 0; b < spec.totalBeats; b += VOCAL_WINDOW_BEATS) {
    vocalActivity.push({
      startMs: b * msPerBeat,
      endMs: Math.min(durationMs, (b + VOCAL_WINDOW_BEATS) * msPerBeat),
      activity: spec.vocalAtBeat(b + VOCAL_WINDOW_BEATS / 2),
      confidence: 0.9,
    });
  }

  return {
    audioHash: `fixture-${spec.bpm}-${spec.key.camelot}`,
    analysisVersion: 1,
    depth: "deep",
    durationSec,
    bpm: spec.bpm,
    tempoConfidence: spec.tempoConfidence,
    grid: {
      beatsMs,
      downbeatsMs,
      beatsPerBar: 4,
      confidence: spec.gridConfidence,
    },
    key: spec.key,
    sections: spec.sections.map((s) => ({
      kind: s.kind,
      startMs: s.fromBeat * msPerBeat,
      endMs: s.toBeat * msPerBeat,
      meanEnergy: s.energy,
    })),
    energyCurvePerSec,
    energyContour,
    vocalActivity,
    drops: spec.drops.map((d) => ({
      atMs: d.atBeat * msPerBeat,
      strength: d.strength,
    })),
    loudnessRms,
  };
}

function facts(id: string, spec: FixtureSpec): TrackFacts {
  const read = buildFixtureRead(spec);
  return buildTrackFacts(id, read, read.durationSec * 1000);
}

const KEY_C_MAJOR: TrackReadKey = {
  tonic: 0,
  mode: "major",
  camelot: "8B",
  confidence: 0.9,
};
const KEY_G_MAJOR: TrackReadKey = {
  tonic: 7,
  mode: "major",
  camelot: "9B",
  confidence: 0.9,
};
const KEY_A_MINOR: TrackReadKey = {
  tonic: 9,
  mode: "minor",
  camelot: "8A",
  confidence: 0.9,
};
const KEY_EB_MAJOR: TrackReadKey = {
  tonic: 3,
  mode: "major",
  camelot: "3B",
  confidence: 0.9,
};

const CLUB_SECTIONS_A: FixtureSection[] = [
  { kind: "intro", fromBeat: 0, toBeat: 32, energy: 0.07 },
  { kind: "verse", fromBeat: 32, toBeat: 128, energy: 0.2 },
  { kind: "chorus", fromBeat: 128, toBeat: 256, energy: 0.34 },
  { kind: "breakdown", fromBeat: 256, toBeat: 320, energy: 0.1 },
  { kind: "chorus", fromBeat: 320, toBeat: 448, energy: 0.34 },
  { kind: "outro", fromBeat: 448, toBeat: 512, energy: 0.13 },
];

const CLUB_SECTIONS_B: FixtureSection[] = [
  { kind: "intro", fromBeat: 0, toBeat: 32, energy: 0.07 },
  { kind: "chorus", fromBeat: 32, toBeat: 160, energy: 0.35 },
  { kind: "verse", fromBeat: 160, toBeat: 256, energy: 0.2 },
  { kind: "breakdown", fromBeat: 256, toBeat: 320, energy: 0.09 },
  { kind: "chorus", fromBeat: 320, toBeat: 448, energy: 0.35 },
  { kind: "outro", fromBeat: 448, toBeat: 512, energy: 0.12 },
];

/** Tidy club pair: trusted grids, adjacent keys, 124 → 126 bpm. */
export const clubA: TrackFacts = facts("club-a", {
  bpm: 124,
  totalBeats: 512,
  key: KEY_C_MAJOR,
  tempoConfidence: 0.8,
  gridConfidence: 0.85,
  sections: CLUB_SECTIONS_A,
  drops: [
    { atBeat: 128, strength: 2.2 },
    { atBeat: 320, strength: 2.4 },
  ],
  vocalAtBeat: (b) =>
    b < 32
      ? 0.08
      : b < 128
        ? 0.5
        : b < 256
          ? 0.55
          : b < 320
            ? 0.08
            : b < 448
              ? 0.55
              : 0.08,
  transientZones: [
    [0, 32],
    [256, 320],
    [448, 512],
  ],
});

export const clubB: TrackFacts = facts("club-b", {
  bpm: 126,
  totalBeats: 512,
  key: KEY_G_MAJOR,
  tempoConfidence: 0.8,
  gridConfidence: 0.85,
  sections: CLUB_SECTIONS_B,
  drops: [
    { atBeat: 32, strength: 2.6 },
    { atBeat: 320, strength: 2.4 },
  ],
  vocalAtBeat: (b) =>
    b < 32
      ? 0.08
      : b < 160
        ? 0.5
        : b < 256
          ? 0.45
          : b < 320
            ? 0.08
            : b < 448
              ? 0.5
              : 0.08,
  transientZones: [
    [0, 32],
    [256, 320],
    [448, 512],
  ],
});

/** Vocal pop pair: singing almost everywhere, smooth (flat) contour. */
export const popA: TrackFacts = facts("pop-a", {
  bpm: 100,
  totalBeats: 480,
  key: KEY_C_MAJOR,
  tempoConfidence: 0.75,
  gridConfidence: 0.8,
  sections: [
    { kind: "intro", fromBeat: 0, toBeat: 32, energy: 0.1 },
    { kind: "verse", fromBeat: 32, toBeat: 128, energy: 0.22 },
    { kind: "chorus", fromBeat: 128, toBeat: 224, energy: 0.3 },
    { kind: "breakdown", fromBeat: 224, toBeat: 288, energy: 0.12 },
    { kind: "chorus", fromBeat: 288, toBeat: 384, energy: 0.3 },
    { kind: "outro", fromBeat: 384, toBeat: 480, energy: 0.14 },
  ],
  drops: [],
  vocalAtBeat: (b) => (b < 224 ? 0.85 : b < 288 ? 0.3 : b < 384 ? 0.85 : 0.18),
  transientZones: [],
});

export const popB: TrackFacts = facts("pop-b", {
  bpm: 102,
  totalBeats: 480,
  key: KEY_A_MINOR,
  tempoConfidence: 0.75,
  gridConfidence: 0.8,
  sections: [
    { kind: "intro", fromBeat: 0, toBeat: 32, energy: 0.09 },
    { kind: "verse", fromBeat: 32, toBeat: 128, energy: 0.21 },
    { kind: "chorus", fromBeat: 128, toBeat: 256, energy: 0.3 },
    { kind: "bridge", fromBeat: 256, toBeat: 320, energy: 0.18 },
    { kind: "chorus", fromBeat: 320, toBeat: 448, energy: 0.3 },
    { kind: "outro", fromBeat: 448, toBeat: 480, energy: 0.13 },
  ],
  drops: [],
  vocalAtBeat: (b) => (b < 448 ? 0.82 : 0.2),
  transientZones: [],
});

/** Drop-heavy pair: B drops 16 beats in; A has a 16-beat outro tail. */
export const dropA: TrackFacts = facts("drop-a", {
  bpm: 128,
  totalBeats: 512,
  key: KEY_C_MAJOR,
  tempoConfidence: 0.85,
  gridConfidence: 0.9,
  sections: [
    { kind: "intro", fromBeat: 0, toBeat: 32, energy: 0.08 },
    { kind: "verse", fromBeat: 32, toBeat: 128, energy: 0.2 },
    { kind: "chorus", fromBeat: 128, toBeat: 256, energy: 0.33 },
    { kind: "breakdown", fromBeat: 256, toBeat: 384, energy: 0.1 },
    { kind: "chorus", fromBeat: 384, toBeat: 496, energy: 0.33 },
    { kind: "outro", fromBeat: 496, toBeat: 512, energy: 0.12 },
  ],
  drops: [
    { atBeat: 128, strength: 2.0 },
    { atBeat: 384, strength: 2.2 },
  ],
  vocalAtBeat: (b) =>
    b < 32
      ? 0.1
      : b < 128
        ? 0.45
        : b < 256
          ? 0.5
          : b < 384
            ? 0.08
            : b < 496
              ? 0.5
              : 0.08,
  transientZones: [
    [0, 32],
    [256, 384],
    [496, 512],
  ],
});

export const dropB: TrackFacts = facts("drop-b", {
  bpm: 128,
  totalBeats: 512,
  key: KEY_G_MAJOR,
  tempoConfidence: 0.85,
  gridConfidence: 0.9,
  sections: [
    { kind: "intro", fromBeat: 0, toBeat: 16, energy: 0.07 },
    { kind: "drop", fromBeat: 16, toBeat: 144, energy: 0.36 },
    { kind: "verse", fromBeat: 144, toBeat: 256, energy: 0.2 },
    { kind: "breakdown", fromBeat: 256, toBeat: 320, energy: 0.09 },
    { kind: "drop", fromBeat: 320, toBeat: 448, energy: 0.36 },
    { kind: "outro", fromBeat: 448, toBeat: 512, energy: 0.12 },
  ],
  drops: [
    { atBeat: 16, strength: 3.0 },
    { atBeat: 320, strength: 2.6 },
  ],
  // The drop lands instrumentally; vocals arrive at beat 24.
  vocalAtBeat: (b) =>
    b < 24
      ? 0.08
      : b < 144
        ? 0.48
        : b < 256
          ? 0.45
          : b < 320
            ? 0.08
            : b < 448
              ? 0.48
              : 0.1,
  transientZones: [
    [0, 16],
    [256, 320],
    [448, 512],
  ],
});

/** Untrusted-tempo folk pair: grids exist, confidences below trust. */
export const folkA: TrackFacts = facts("folk-a", {
  bpm: 92,
  totalBeats: 384,
  key: KEY_C_MAJOR,
  tempoConfidence: 0.05,
  gridConfidence: 0.08,
  sections: [
    { kind: "intro", fromBeat: 0, toBeat: 32, energy: 0.09 },
    { kind: "verse", fromBeat: 32, toBeat: 128, energy: 0.2 },
    { kind: "chorus", fromBeat: 128, toBeat: 224, energy: 0.28 },
    { kind: "breakdown", fromBeat: 224, toBeat: 288, energy: 0.1 },
    { kind: "outro", fromBeat: 288, toBeat: 384, energy: 0.11 },
  ],
  drops: [],
  vocalAtBeat: (b) =>
    b < 32 ? 0.15 : b < 128 ? 0.6 : b < 224 ? 0.65 : b < 288 ? 0.15 : 0.12,
  transientZones: [
    [0, 32],
    [224, 384],
  ],
});

export const folkB: TrackFacts = facts("folk-b", {
  bpm: 95,
  totalBeats: 384,
  key: KEY_A_MINOR,
  tempoConfidence: 0.04,
  gridConfidence: 0.07,
  sections: [
    { kind: "intro", fromBeat: 0, toBeat: 32, energy: 0.08 },
    { kind: "verse", fromBeat: 32, toBeat: 160, energy: 0.22 },
    { kind: "chorus", fromBeat: 160, toBeat: 288, energy: 0.27 },
    { kind: "outro", fromBeat: 288, toBeat: 384, energy: 0.12 },
  ],
  drops: [],
  vocalAtBeat: (b) => (b < 32 ? 0.1 : b < 160 ? 0.55 : b < 288 ? 0.6 : 0.15),
  transientZones: [
    [0, 32],
    [288, 384],
  ],
});

/** Distant-key pair: C major → Eb major (Camelot 8B → 3B). */
export const distantA: TrackFacts = facts("distant-a", {
  bpm: 122,
  totalBeats: 512,
  key: KEY_C_MAJOR,
  tempoConfidence: 0.8,
  gridConfidence: 0.85,
  sections: CLUB_SECTIONS_A,
  drops: [{ atBeat: 128, strength: 2.2 }],
  vocalAtBeat: (b) => (b < 448 ? 0.4 : 0.08),
  transientZones: [[448, 512]],
});

export const distantB: TrackFacts = facts("distant-b", {
  bpm: 123,
  totalBeats: 512,
  key: KEY_EB_MAJOR,
  tempoConfidence: 0.8,
  gridConfidence: 0.85,
  sections: CLUB_SECTIONS_B,
  drops: [{ atBeat: 32, strength: 2.4 }],
  vocalAtBeat: (b) => (b < 32 ? 0.08 : 0.45),
  transientZones: [[0, 32]],
});

export const FIXTURE_PAIRS: { name: string; a: TrackFacts; b: TrackFacts }[] = [
  { name: "tidy club", a: clubA, b: clubB },
  { name: "vocal pop", a: popA, b: popB },
  { name: "drop-heavy", a: dropA, b: dropB },
  { name: "untrusted folk", a: folkA, b: folkB },
  { name: "distant keys", a: distantA, b: distantB },
];
