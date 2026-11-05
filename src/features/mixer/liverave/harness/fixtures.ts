// fixtures.ts — the harness fixture LIBRARY.
//
// Synthetic tracks spanning the specified archetypes, each with
// KNOWN ground truth (bpm / tonic / mode / Camelot), rendered by
// synthetics.ts and read by running the analyser over the PCM
// exactly once (module-level memo below). fixtureReads holds the
// raw TrackReads; fixtureFacts holds the derived TrackFacts from
// facts.ts. Imports only the engine's analysis and facts modules.

import { analyseSamples } from "../analyse";
import { buildTrackFacts, type TrackFacts, type TrackRead } from "../facts";
import {
  breakTrack,
  gridTrack,
  harmonicSong,
  SYNTH_SAMPLE_RATE,
  type SynthMode,
} from "./synthetics";

export interface FixtureTruth {
  bpm: number;
  /** Tonic pitch class: 0 = C, …, 11 = B. */
  tonic: number;
  mode: SynthMode;
  /** Camelot code for (tonic, mode) — standard wheel labelling. */
  camelot: string;
}

export interface FixtureTrack {
  id: string;
  archetype: string;
  /** Lazy, memoised PCM (generated at most once per process). */
  pcm: () => Float32Array;
  truth: FixtureTruth;
}

function memoPcm(generate: () => Float32Array): () => Float32Array {
  let cached: Float32Array | null = null;
  return () => {
    if (cached === null) cached = generate();
    return cached;
  };
}

// ---------------------------------------------------------------------
// The library — 20 tracks, 17 distinct Camelot codes, both modes
// (18 original archetypes + the two Wave 7 additions below)
// ---------------------------------------------------------------------

export const fixtureTracks: FixtureTrack[] = [
  {
    id: "club-124-c-major",
    archetype: "tidy club",
    pcm: memoPcm(() =>
      gridTrack({
        bpm: 124,
        seconds: 32,
        seed: 101,
        withBasslineKey: { tonic: 0, mode: "major" },
        kickEveryBeat: true,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 124, tonic: 0, mode: "major", camelot: "8B" },
  },
  {
    id: "techno-130-a-minor",
    archetype: "techno instrumental",
    pcm: memoPcm(() =>
      gridTrack({
        bpm: 130,
        seconds: 32,
        seed: 102,
        withBasslineKey: { tonic: 9, mode: "minor" },
        kickEveryBeat: true,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 130, tonic: 9, mode: "minor", camelot: "8A" },
  },
  {
    id: "edm-drop-128-d-minor",
    archetype: "EDM with drop",
    pcm: memoPcm(() =>
      harmonicSong({
        tonic: 2,
        mode: "minor",
        bpm: 128,
        seconds: 36,
        arc: "build",
        dropAtSec: 18,
        seed: 103,
        kickEveryBeat: true,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 128, tonic: 2, mode: "minor", camelot: "7A" },
  },
  {
    id: "hiphop-95-c-minor",
    archetype: "hip-hop-ish with drop",
    pcm: memoPcm(() =>
      harmonicSong({
        tonic: 0,
        mode: "minor",
        bpm: 95,
        seconds: 32,
        arc: "flat",
        dropAtSec: 16,
        seed: 104,
        kickEveryBeat: true,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 95, tonic: 0, mode: "minor", camelot: "5A" },
  },
  {
    id: "vocal-pop-104-g-major",
    archetype: "vocal pop (planted vocal windows)",
    pcm: memoPcm(() =>
      harmonicSong({
        tonic: 7,
        mode: "major",
        bpm: 104,
        seconds: 36,
        arc: "flat",
        // Planted vocal windows: 8–20 s and 24–32 s. Non-vocal
        // reference window used by the tests: 2–6 s.
        vocalWindows: [
          { startSec: 8, endSec: 20 },
          { startSec: 24, endSec: 32 },
        ],
        seed: 105,
        // Low pure-sine pads an octave down: the non-vocal windows
        // keep their sustained energy below the vocal band.
        harmonicLevel: 0.1,
        padOctaveShift: -1,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 104, tonic: 7, mode: "major", camelot: "9B" },
  },
  {
    id: "folk-unsteady-100-d-major",
    archetype: "folk/rock unsteady (tempo drift)",
    pcm: memoPcm(() =>
      gridTrack({
        bpm: 100,
        seconds: 36,
        // +0.35 %/s: 100 BPM at the start, ~112 BPM by the end.
        // Truth bpm is the STARTING tempo; the track is excluded
        // from the ±1 BPM gate by design (it is the unsteady case).
        driftPerSec: 0.0035,
        seed: 106,
        withBasslineKey: { tonic: 2, mode: "major" },
        clickAmp: 0.75,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 100, tonic: 2, mode: "major", camelot: "10B" },
  },
  {
    id: "acoustic-88-a-major",
    archetype: "acoustic quiet",
    pcm: memoPcm(() =>
      harmonicSong({
        tonic: 9,
        mode: "major",
        bpm: 88,
        seconds: 28,
        arc: "flat",
        seed: 107,
        harmonicLevel: 0.5,
        // Soft but definite grid: a foot-tap kick on every beat
        // under brushed clicks (no hats: 2×88 = 176 BPM sits inside
        // the analyser's tempo range and would plant a false grid).
        clickAmp: 0.6,
        kickAmp: 0.18,
        kickEveryBeat: true,
        masterGain: 0.4,
      }),
    ),
    truth: { bpm: 88, tonic: 9, mode: "major", camelot: "11B" },
  },
  {
    id: "house-122-f-major",
    archetype: "house long-arc",
    pcm: memoPcm(() =>
      harmonicSong({
        tonic: 5,
        mode: "major",
        bpm: 122,
        seconds: 36,
        arc: "build",
        seed: 108,
        kickEveryBeat: true,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 122, tonic: 5, mode: "major", camelot: "7B" },
  },
  {
    id: "dnb-174-e-minor",
    archetype: "drum&bass-ish",
    pcm: memoPcm(() =>
      gridTrack({
        bpm: 174,
        seconds: 28,
        seed: 109,
        withBasslineKey: { tonic: 4, mode: "minor" },
        // Stack an octave up: at 174 BPM the per-beat pump's AM
        // sidebands (±2.9 Hz) straddle pitch-class bins down at
        // 65–124 Hz, where a semitone is only ~5 Hz wide.
        basslineOctaveShift: 1,
        kickEveryBeat: true,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 174, tonic: 4, mode: "minor", camelot: "9A" },
  },
  {
    id: "rnb-92-bb-major",
    archetype: "slow R&B (vocals)",
    pcm: memoPcm(() =>
      harmonicSong({
        tonic: 10,
        mode: "major",
        bpm: 92,
        seconds: 32,
        arc: "flat",
        vocalWindows: [
          { startSec: 6, endSec: 18 },
          { startSec: 22, endSec: 30 },
        ],
        seed: 110,
        harmonicLevel: 0.35,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 92, tonic: 10, mode: "major", camelot: "6B" },
  },
  {
    id: "deep-120-fsharp-minor",
    archetype: "deep house instrumental",
    pcm: memoPcm(() =>
      gridTrack({
        bpm: 120,
        seconds: 32,
        seed: 111,
        withBasslineKey: { tonic: 6, mode: "minor" },
        kickEveryBeat: true,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 120, tonic: 6, mode: "minor", camelot: "11A" },
  },
  {
    id: "pop-112-eb-major",
    archetype: "synth pop (vocals)",
    pcm: memoPcm(() =>
      harmonicSong({
        tonic: 3,
        mode: "major",
        bpm: 112,
        seconds: 32,
        arc: "build",
        vocalWindows: [{ startSec: 10, endSec: 22 }],
        seed: 112,
        // Pads stay in the 48–59 band: down at 65–124 Hz a Hann
        // FFT's main lobe spans more than two semitones, so chroma
        // planted there is smeared before the key pass ever sees
        // it (vocal-pop survives octave-down pads only because its
        // vocal stacks carry the chroma at 500–1000 Hz).
        harmonicLevel: 0.2,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 112, tonic: 3, mode: "major", camelot: "5B" },
  },
  {
    id: "rock-140-g-minor",
    archetype: "rock loud-quiet-loud",
    pcm: memoPcm(() =>
      harmonicSong({
        tonic: 7,
        mode: "minor",
        bpm: 140,
        seconds: 36,
        arc: "loud-quiet-loud",
        seed: 113,
        harmonicLevel: 1.2,
        clickAmp: 0.95,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 140, tonic: 7, mode: "minor", camelot: "6A" },
  },
  {
    id: "trance-145-f-minor",
    archetype: "trance (predicted tempo-defect case)",
    // Evidentiary purpose: 145 BPM's beat period is 82.95 of the
    // analyser's 5 ms frames — inside the ≈0.1-of-an-integer zone
    // where 124 / 128 / 140 BPM read at exactly half tempo on pure
    // click trains. This fixture tests that pattern predictively:
    // whatever it reads is evidence for or against the pattern.
    pcm: memoPcm(() =>
      gridTrack({
        bpm: 145,
        seconds: 28,
        seed: 115,
        withBasslineKey: { tonic: 5, mode: "minor" },
        kickEveryBeat: true,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 145, tonic: 5, mode: "minor", camelot: "4A" },
  },
  {
    id: "boombap-93-ab-major",
    archetype: "boom-bap hip-hop (no drop)",
    // Evidentiary purpose: Ab major — a flat-side key next door to
    // Eb major (the library's one key misread) — isolates whether
    // the Eb failure is tonic-specific.
    pcm: memoPcm(() =>
      harmonicSong({
        tonic: 8,
        mode: "major",
        bpm: 93,
        seconds: 32,
        arc: "flat",
        seed: 116,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 93, tonic: 8, mode: "major", camelot: "4B" },
  },
  {
    id: "jungle-160-b-minor",
    archetype: "jungle / fast breakbeat-ish",
    pcm: memoPcm(() =>
      gridTrack({
        bpm: 160,
        seconds: 28,
        seed: 117,
        withBasslineKey: { tonic: 11, mode: "minor" },
        basslineOctaveShift: 1,
        kickEveryBeat: true,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 160, tonic: 11, mode: "minor", camelot: "10A" },
  },
  {
    id: "deeptech-115-c-major",
    archetype: "deep techno (second C-major tempo)",
    pcm: memoPcm(() =>
      gridTrack({
        bpm: 115,
        seconds: 32,
        seed: 118,
        withBasslineKey: { tonic: 0, mode: "major" },
        kickEveryBeat: true,
        hats: true,
        backbeat: true,
      }),
    ),
    truth: { bpm: 115, tonic: 0, mode: "major", camelot: "8B" },
  },
  {
    id: "breakbeat-100-a-minor",
    archetype: "breakbeat (drum-break head and tail, drop into the body)",
    // Wave 7 addition: the library had no scratch-shaped windows —
    // every track's head/tail windows are sustained pads whose
    // transient scores cap at ~0.45. A real breakbeat's breaks are
    // hits over air: 16-beat breaks at the head and the tail of a
    // 64-beat render, with a hits-free final second before the body
    // so the body entry measures as a drop at beat 16.
    pcm: memoPcm(() =>
      breakTrack({
        bpm: 100,
        seconds: 38.4,
        tonic: 9,
        mode: "minor",
        breakBeats: 16,
        seed: 119,
      }),
    ),
    truth: { bpm: 100, tonic: 9, mode: "minor", camelot: "8A" },
  },
  {
    id: "outro-120-c-major",
    archetype: "song form with a real outro (step-down ending)",
    // Wave 7 addition: every pre-existing archetype ends at full
    // tilt (flat/build arcs with no ending gesture), so the
    // analyser — which types an outro from a decisive energy step
    // into a final segment — never saw one. This track ends like a
    // real song: full level for 24 s, then a decisive step down to
    // quarter level for the final 13 s (~26 beats at 120 BPM —
    // clear of both the 24-beat brake tail line and the 28-beat
    // long-blend centre the loop-blend test compares against).
    pcm: memoPcm(() => {
      const buf = harmonicSong({
        tonic: 0,
        mode: "major",
        bpm: 120,
        seconds: 37,
        arc: "flat",
        seed: 120,
        kickEveryBeat: true,
        hats: true,
        backbeat: true,
      });
      for (let i = 0; i < buf.length; i += 1) {
        if (i / SYNTH_SAMPLE_RATE >= 24) buf[i] *= 0.25;
      }
      return buf;
    }),
    truth: { bpm: 120, tonic: 0, mode: "major", camelot: "8B" },
  },
  {
    id: "chill-78-e-major",
    archetype: "downtempo chill",
    pcm: memoPcm(() =>
      gridTrack({
        bpm: 78,
        seconds: 28,
        seed: 114,
        withBasslineKey: { tonic: 4, mode: "major" },
        clickAmp: 0.7,
        masterGain: 0.8,
        backbeat: true,
      }),
    ),
    truth: { bpm: 78, tonic: 4, mode: "major", camelot: "12B" },
  },
];

// ---------------------------------------------------------------------
// Playlist arcs — named energy orderings over the library
// ---------------------------------------------------------------------

export interface FixturePlaylist {
  name: string;
  /** Ordered fixture track ids. */
  trackIds: string[];
}

export const fixturePlaylists: FixturePlaylist[] = [
  {
    name: "warm-up → peak → comedown",
    trackIds: [
      "chill-78-e-major",
      "acoustic-88-a-major",
      "rnb-92-bb-major",
      "house-122-f-major",
      "club-124-c-major",
      "edm-drop-128-d-minor",
      "techno-130-a-minor",
      "dnb-174-e-minor",
      "vocal-pop-104-g-major",
      "folk-unsteady-100-d-major",
    ],
  },
  {
    name: "steady groove",
    trackIds: [
      "deep-120-fsharp-minor",
      "outro-120-c-major",
      "house-122-f-major",
      "club-124-c-major",
      "edm-drop-128-d-minor",
      "techno-130-a-minor",
      "deep-120-fsharp-minor",
    ],
  },
  {
    name: "vocal journey",
    trackIds: [
      "acoustic-88-a-major",
      "rnb-92-bb-major",
      "vocal-pop-104-g-major",
      "pop-112-eb-major",
      "folk-unsteady-100-d-major",
      "rock-140-g-minor",
    ],
  },
  {
    name: "minor-key descent",
    trackIds: [
      "deep-120-fsharp-minor",
      "edm-drop-128-d-minor",
      "techno-130-a-minor",
      "rock-140-g-minor",
      "trance-145-f-minor",
      "jungle-160-b-minor",
      "dnb-174-e-minor",
    ],
  },
  {
    name: "tempo ladder",
    trackIds: [
      "chill-78-e-major",
      "boombap-93-ab-major",
      "hiphop-95-c-minor",
      "vocal-pop-104-g-major",
      "deeptech-115-c-major",
      "house-122-f-major",
      "club-124-c-major",
      "trance-145-f-minor",
      "dnb-174-e-minor",
    ],
  },
];

// ---------------------------------------------------------------------
// Reads + facts — the analyser run ONCE over the library (memo)
// ---------------------------------------------------------------------

const generationStart = Date.now();
for (const track of fixtureTracks) track.pcm();
export const fixtureGenerationMs = Date.now() - generationStart;

const analysisStart = Date.now();
export const fixtureReads: Map<string, TrackRead> = new Map();
for (const track of fixtureTracks) {
  const read = analyseSamples(track.pcm(), SYNTH_SAMPLE_RATE, {
    depth: "deep",
  });
  if (read === null) {
    throw new Error(
      `fixtures: analyser returned null for ${track.id} — ` +
        "the synthetic is unreadable (near-silence or degenerate)",
    );
  }
  fixtureReads.set(track.id, read);
}
/** Wall time of the single library-wide analysis pass. */
export const fixtureAnalysisMs = Date.now() - analysisStart;

export const fixtureFacts: Map<string, TrackFacts> = new Map();
for (const track of fixtureTracks) {
  const read = fixtureReads.get(track.id);
  if (!read) continue;
  fixtureFacts.set(
    track.id,
    buildTrackFacts(track.id, read, read.durationSec * 1000),
  );
}
