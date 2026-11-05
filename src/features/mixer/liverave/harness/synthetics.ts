// synthetics.ts — PCM generators with KNOWN ground truth (harness).
//
// Every generator renders mono Float32Array PCM at SYNTH_SAMPLE_RATE
// with musically structured content whose planted features are the
// fixture library's ground truth: clicks/kicks on a beat grid (with
// optional linear tempo drift), harmonic chord stacks in a stated
// key, vocal-band formant-ish stacks inside stated windows, energy
// arcs, and a planted drop (a quiet bar, then a full-energy return).
//
// Design notes (written against the analyser's documented
// measurement choices, so the planted features are really there):
// - Tempo is read from an onset envelope, so every generator carries
//   a percussive grid: broadband noise clicks on every beat, accent
//   beats louder, plus a low sine kick on accents.
// - Key is read from a chromagram, so chord stacks are diatonic
//   triads with the tonic chord emphasised in the progression.
//   Stacks use harmonics 2/3/4 only: the 5th harmonic of a root is
//   (approximately) a MAJOR third, which would inject the wrong
//   third into a minor key's chroma.
// - Vocal activity is read as FFT energy share in ~300 Hz–3.4 kHz.
//   Vocal stacks are therefore sustained chord-tone stacks centred
//   near 800 Hz with vibrato (in-band, and chroma-consistent),
//   while non-vocal backing keeps its sustained energy below
//   300 Hz (pure-sine low triads / bass) or broadband (clicks),
//   both of which honestly read as non-vocal under that measure.
// - Drops are read as 1 s-after vs 1 s-before RMS surges, so the
//   planted drop is a full 2 s quiet window ending exactly at
//   dropAtSec, with full energy returning at dropAtSec.
//
// Deterministic: all noise comes from a seeded PRNG stream, and
// oscillator rendering is wavetable-based (fast and repeatable).

export const SYNTH_SAMPLE_RATE = 44100;

// ---------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------

/** mulberry32 — tiny deterministic PRNG, returns values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SINE_TABLE_SIZE = 8192;
const SINE_TABLE = new Float32Array(SINE_TABLE_SIZE + 1);
for (let i = 0; i <= SINE_TABLE_SIZE; i += 1) {
  SINE_TABLE[i] = Math.sin((2 * Math.PI * i) / SINE_TABLE_SIZE);
}

function sineAt(phase: number): number {
  const wrapped = phase - Math.floor(phase);
  return SINE_TABLE[Math.round(wrapped * SINE_TABLE_SIZE)];
}

export function freqOfMidi(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

interface ToneOptions {
  freq: number;
  amp: number;
  fromSec: number;
  toSec: number;
  /** Vibrato depth as a fractional frequency wobble (0 = none). */
  vibratoDepth?: number;
  vibratoHz?: number;
  phase0?: number;
}

/** Add one wavetable sine tone into the buffer. */
function addTone(buf: Float32Array, sr: number, opts: ToneOptions): void {
  const from = Math.max(0, Math.floor(opts.fromSec * sr));
  const to = Math.min(buf.length, Math.ceil(opts.toSec * sr));
  if (to <= from) return;
  const depth = opts.vibratoDepth ?? 0;
  const vibHz = opts.vibratoHz ?? 5.5;
  const vibPhase = opts.phase0 ?? 0;
  let phase = vibPhase;
  for (let i = from; i < to; i += 1) {
    const t = i / sr;
    const wobble =
      depth > 0 ? 1 + depth * Math.sin(2 * Math.PI * vibHz * t + vibPhase) : 1;
    phase += (opts.freq * wobble) / sr;
    buf[i] += opts.amp * sineAt(phase);
  }
}

/** Broadband noise burst: exponentially decaying white noise. */
function addNoiseBurst(
  buf: Float32Array,
  sr: number,
  rng: () => number,
  atSec: number,
  amp: number,
  lengthSec: number,
  tauSec: number,
): void {
  const start = Math.round(atSec * sr);
  const length = Math.round(lengthSec * sr);
  for (let i = 0; i < length && start + i < buf.length; i += 1) {
    const t = i / sr;
    buf[start + i] += amp * Math.exp(-t / tauSec) * (rng() * 2 - 1);
  }
}

/** Broadband noise click: a short, sharp burst. */
function addClick(
  buf: Float32Array,
  sr: number,
  rng: () => number,
  atSec: number,
  amp: number,
): void {
  addNoiseBurst(buf, sr, rng, atSec, amp, 0.03, 0.006);
}

/**
 * The percussive grid furniture, shared by both generators: offbeat
 * hats (half-beat noise ticks) and backbeat snaps (beats 2 and 4).
 * Hats double the onset density at grid positions; callers only
 * enable them when twice the tempo is above the analyser's 180 BPM
 * ceiling, so the hat grid can never be mistaken for the beat.
 */
function addGridFurniture(
  buf: Float32Array,
  sr: number,
  rng: () => number,
  beats: number[],
  opts: { hats: boolean; backbeat: boolean },
): void {
  if (opts.backbeat) {
    beats.forEach((t, i) => {
      if (i % 4 === 1 || i % 4 === 3) {
        addNoiseBurst(buf, sr, rng, t, 0.5, 0.045, 0.012);
      }
    });
  }
  if (opts.hats) {
    for (let i = 0; i + 1 < beats.length; i += 1) {
      const mid = (beats[i] + beats[i + 1]) / 2;
      addNoiseBurst(buf, sr, rng, mid, 0.3, 0.015, 0.004);
    }
  }
}

/** Low kick: sine burst sweeping 100 Hz down to ~45 Hz. */
function addKick(
  buf: Float32Array,
  sr: number,
  atSec: number,
  amp: number,
): void {
  const start = Math.round(atSec * sr);
  const length = Math.round(0.12 * sr);
  let phase = 0;
  for (let i = 0; i < length && start + i < buf.length; i += 1) {
    const t = i / sr;
    const freq = 45 + 55 * Math.exp(-t / 0.025);
    phase += freq / sr;
    buf[start + i] += amp * Math.exp(-t / 0.04) * sineAt(phase);
  }
}

/**
 * Per-beat pumping of the sustained layers (the sidechain gesture
 * every one of these genres uses): gain is 1 exactly on each beat
 * and decays between beats. This is musically honest — and it means
 * the sustained layers themselves carry the beat grid, instead of
 * sitting as a steady drone whose short-window RMS ripple has no
 * relation to the tempo.
 */
function applyBeatPump(
  buf: Float32Array,
  sr: number,
  beats: number[],
  depth: number,
  decay: number,
): void {
  if (depth <= 0 || beats.length < 2) return;
  let bi = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const t = i / sr;
    while (bi + 1 < beats.length && beats[bi + 1] <= t) bi += 1;
    if (t < beats[0]) continue;
    const b0 = beats[bi];
    const b1 =
      bi + 1 < beats.length ? beats[bi + 1] : b0 + (b0 - beats[bi - 1]);
    const phase = Math.min(1, Math.max(0, (t - b0) / Math.max(1e-6, b1 - b0)));
    const env = 1 - depth + depth * Math.exp(-decay * phase);
    buf[i] *= env;
  }
}

/** Beat times for a (possibly drifting) tempo, from firstBeatSec. */
export function beatTimes(
  bpm: number,
  seconds: number,
  firstBeatSec: number,
  driftPerSec = 0,
): number[] {
  const times: number[] = [];
  let t = firstBeatSec;
  while (t < seconds - 0.05) {
    times.push(t);
    const instantBpm = bpm * (1 + driftPerSec * t);
    t += 60 / Math.max(20, instantBpm);
  }
  return times;
}

// ---------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------

export type SynthMode = "major" | "minor";

export interface ChordDef {
  /** Semitone offset of the chord root from the tonic. */
  rootOffset: number;
  /** Third interval in semitones (4 major, 3 minor). */
  third: number;
  /** Fifth interval in semitones. */
  fifth: number;
}

/**
 * Diatonic progression (one chord per bar) with the TONIC chord on
 * half the bars: relative major/minor keys share every pitch class,
 * so only tonic emphasis in the distribution makes a key honestly
 * readable — equal-weight I–V–vi–IV is genuinely ambiguous between
 * a key and its relative, and a fixture must not plant ambiguity
 * and then demand an exact read. Major: I – I – V – IV (the
 * relative minor's tonic chord, vi, is deliberately absent).
 * Natural minor: i – i – VII – VI (the relative major's tonic
 * chord, III, is deliberately absent).
 */
export function progressionFor(mode: SynthMode): ChordDef[] {
  if (mode === "major") {
    return [
      { rootOffset: 0, third: 4, fifth: 7 }, // I
      { rootOffset: 0, third: 4, fifth: 7 }, // I
      { rootOffset: 7, third: 4, fifth: 7 }, // V
      { rootOffset: 5, third: 4, fifth: 7 }, // IV
    ];
  }
  return [
    { rootOffset: 0, third: 3, fifth: 7 }, // i
    { rootOffset: 0, third: 3, fifth: 7 }, // i
    { rootOffset: 10, third: 4, fifth: 7 }, // VII
    { rootOffset: 8, third: 4, fifth: 7 }, // VI
  ];
}

/** Midi note of a chord root: base root midi lifted by the offset. */
function chordRootMidi(baseRootMidi: number, chord: ChordDef): number {
  return baseRootMidi + chord.rootOffset;
}

/** The midi whose pitch class is `tonic`, inside [lo, hi). */
function rootMidiInRange(tonic: number, lo: number, hi: number): number {
  for (let m = lo; m < hi; m += 1) {
    if (((m % 12) + 12) % 12 === ((tonic % 12) + 12) % 12) return m;
  }
  return lo + ((((tonic - lo) % 12) + 12) % 12);
}

// ---------------------------------------------------------------------
// Chord-bar rendering (cached: a bar of a given chord renders once)
// ---------------------------------------------------------------------

const chordBarCache = new Map<string, Float32Array>();

interface ChordBarOptions {
  baseRootMidi: number;
  chord: ChordDef;
  barSamples: number;
  harmonicLevel: number;
  /** Peak amplitude of one chord tone's fundamental. */
  toneAmp: number;
}

/**
 * One bar of a sustained triad stack: each chord tone rendered as
 * fundamental + harmonics 2/3/4 (scaled by harmonicLevel), the
 * fundamental and 2nd harmonic as ±4-cent detuned pairs (a slight
 * chorus), with 25 ms raised-cosine edges so bars tile without
 * clicks. Cached by full parameter key.
 */
function renderChordBar(sr: number, opts: ChordBarOptions): Float32Array {
  const key = [
    opts.baseRootMidi,
    opts.chord.rootOffset,
    opts.chord.third,
    opts.barSamples,
    opts.harmonicLevel.toFixed(3),
    opts.toneAmp.toFixed(3),
  ].join("|");
  const cached = chordBarCache.get(key);
  if (cached) return cached;

  const bar = new Float32Array(opts.barSamples);
  const root = chordRootMidi(opts.baseRootMidi, opts.chord);
  const tones = [root, root + opts.chord.third, root + opts.chord.fifth];
  const toneAmps = [1, 0.72, 0.72];
  const detune = Math.pow(2, 4 / 1200);
  tones.forEach((midi, ti) => {
    const freq = freqOfMidi(midi);
    const amp = opts.toneAmp * toneAmps[ti];
    // Richer harmonics: energy at 2f/3f/4f sits at the SAME pitch
    // classes (octave / fifth / octave) but ripples far less in
    // short RMS windows than the fundamental does — a real stack
    // is never a pure sine, and a pure sine is the pathological
    // case for onset measurement.
    const parts: { mult: number; rel: number }[] = [
      { mult: 1, rel: 1 },
      { mult: 2, rel: 0.65 * opts.harmonicLevel },
      { mult: 3, rel: 0.5 * opts.harmonicLevel },
      { mult: 4, rel: 0.4 * opts.harmonicLevel },
    ];
    for (const part of parts) {
      if (part.rel <= 0.001) continue;
      if (part.mult <= 2) {
        // Detuned chorus pair.
        addTone(bar, sr, {
          freq: freq * part.mult * detune,
          amp: (amp * part.rel) / 2,
          fromSec: 0,
          toSec: opts.barSamples / sr,
          phase0: ti * 0.7 + part.mult,
        });
        addTone(bar, sr, {
          freq: (freq * part.mult) / detune,
          amp: (amp * part.rel) / 2,
          fromSec: 0,
          toSec: opts.barSamples / sr,
          phase0: ti * 1.3 + part.mult * 2,
        });
      } else {
        addTone(bar, sr, {
          freq: freq * part.mult,
          amp: amp * part.rel,
          fromSec: 0,
          toSec: opts.barSamples / sr,
          phase0: ti + part.mult,
        });
      }
    }
  });
  // Root octave, quiet, for body.
  addTone(bar, sr, {
    freq: freqOfMidi(root + 12),
    amp: opts.toneAmp * 0.35,
    fromSec: 0,
    toSec: opts.barSamples / sr,
    phase0: 0.4,
  });

  // Raised-cosine edges (25 ms) so bars tile cleanly.
  const fade = Math.min(Math.round(0.025 * sr), opts.barSamples >> 2);
  for (let i = 0; i < fade; i += 1) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    bar[i] *= w;
    bar[opts.barSamples - 1 - i] *= w;
  }
  chordBarCache.set(key, bar);
  return bar;
}

/** Tile chord bars (progression order) across the whole buffer. */
function layChordBars(
  buf: Float32Array,
  sr: number,
  opts: {
    tonic: number;
    mode: SynthMode;
    bpm: number;
    baseRootMidi: number;
    harmonicLevel: number;
    toneAmp: number;
  },
): void {
  const barSec = (4 * 60) / opts.bpm;
  const barSamples = Math.round(barSec * sr);
  const progression = progressionFor(opts.mode);
  const barCount = Math.ceil(buf.length / barSamples);
  for (let b = 0; b < barCount; b += 1) {
    const chord = progression[b % progression.length];
    const bar = renderChordBar(sr, {
      baseRootMidi: opts.baseRootMidi,
      chord,
      barSamples,
      harmonicLevel: opts.harmonicLevel,
      toneAmp: opts.toneAmp,
    });
    const offset = b * barSamples;
    for (let i = 0; i < barSamples && offset + i < buf.length; i += 1) {
      buf[offset + i] += bar[i];
    }
  }
}

/** Lay a pure-sine bass root under each bar (the chord's root, low). */
function layBassline(
  buf: Float32Array,
  sr: number,
  opts: {
    tonic: number;
    mode: SynthMode;
    bpm: number;
    amp: number;
    /** Root band for the bass notes (default midi 36–47). */
    rootLo?: number;
    rootHi?: number;
  },
): void {
  const barSec = (4 * 60) / opts.bpm;
  const progression = progressionFor(opts.mode);
  const barCount = Math.ceil(buf.length / (barSec * sr));
  for (let b = 0; b < barCount; b += 1) {
    const chord = progression[b % progression.length];
    // Bass root: the chord root's pitch class in the root band.
    const pc = (((opts.tonic + chord.rootOffset) % 12) + 12) % 12;
    const midi = rootMidiInRange(pc, opts.rootLo ?? 36, opts.rootHi ?? 48);
    addTone(buf, sr, {
      freq: freqOfMidi(midi),
      amp: opts.amp,
      fromSec: b * barSec + 0.01,
      toSec: Math.min(buf.length / sr, (b + 1) * barSec - 0.01),
      phase0: b * 0.3,
    });
  }
}

/** Safety: scale down ONLY if the render would clip (peak > 0.98). */
function softCeiling(buf: Float32Array): void {
  let peak = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  if (peak > 0.98) {
    const scale = 0.98 / peak;
    for (let i = 0; i < buf.length; i += 1) buf[i] *= scale;
  }
}

// ---------------------------------------------------------------------
// gridTrack — clicks on a beat grid + optional harmonic bassline
// ---------------------------------------------------------------------

export interface GridTrackOptions {
  bpm: number;
  seconds: number;
  /** Fractional tempo drift per second (0.0035 ≈ +0.35 %/s). */
  driftPerSec?: number;
  /** Accent (kick + louder click) every N beats. Default 4. */
  accentEvery?: number;
  /** When given, a triad bassline stack in this key under the grid. */
  withBasslineKey?: { tonic: number; mode: SynthMode };
  /** Octave shift for the bassline stack's root band (36–47). */
  basslineOctaveShift?: number;
  /** Kick on every beat (four-on-the-floor), not just accents. */
  kickEveryBeat?: boolean;
  /** Offbeat hats at half-beats (only when 2×bpm > 180). */
  hats?: boolean;
  /** Backbeat snaps on beats 2 and 4 of each bar. */
  backbeat?: boolean;
  seed?: number;
  clickAmp?: number;
  kickAmp?: number;
  masterGain?: number;
  firstBeatSec?: number;
}

export function gridTrack(opts: GridTrackOptions): Float32Array {
  const sr = SYNTH_SAMPLE_RATE;
  const buf = new Float32Array(Math.round(opts.seconds * sr));
  const rng = mulberry32(opts.seed ?? 1);
  const accentEvery = opts.accentEvery ?? 4;
  const clickAmp = opts.clickAmp ?? 0.9;
  const kickAmp = opts.kickAmp ?? 0.5;
  const firstBeatSec = opts.firstBeatSec ?? 0.3;

  const beats = beatTimes(
    opts.bpm,
    opts.seconds,
    firstBeatSec,
    opts.driftPerSec ?? 0,
  );

  if (opts.withBasslineKey) {
    const { tonic, mode } = opts.withBasslineKey;
    // Bassline stack: pure-sine triads in the 36–47 root band —
    // sustained energy below 300 Hz, chroma-clean.
    const shift = (opts.basslineOctaveShift ?? 0) * 12;
    layChordBars(buf, sr, {
      tonic,
      mode,
      bpm: opts.bpm,
      baseRootMidi: rootMidiInRange(tonic, 36 + shift, 48 + shift),
      harmonicLevel: 0.7,
      toneAmp: 0.13,
    });
    layBassline(buf, sr, {
      tonic,
      mode,
      bpm: opts.bpm,
      amp: 0.17,
      rootLo: 36 + shift,
      rootHi: 48 + shift,
    });
    // A bassline pumps against the kick; it is not a drone.
    applyBeatPump(buf, sr, beats, 0.8, 2.2);
  }

  beats.forEach((t, i) => {
    const accent = i % accentEvery === 0;
    addClick(buf, sr, rng, t, accent ? clickAmp : clickAmp * 0.62);
    if (kickAmp > 0 && (accent || opts.kickEveryBeat)) {
      addKick(buf, sr, t, accent ? kickAmp : kickAmp * 0.8);
    }
  });
  addGridFurniture(buf, sr, rng, beats, {
    hats: opts.hats ?? false,
    backbeat: opts.backbeat ?? false,
  });

  const gain = opts.masterGain ?? 1;
  if (gain !== 1) {
    for (let i = 0; i < buf.length; i += 1) buf[i] *= gain;
  }
  softCeiling(buf);
  return buf;
}

// ---------------------------------------------------------------------
// harmonicSong — chord stacks + energy arc + vocals + a planted drop
// ---------------------------------------------------------------------

export type EnergyArc = "flat" | "build" | "loud-quiet-loud";

export interface VocalWindowSpec {
  startSec: number;
  endSec: number;
}

export interface HarmonicSongOptions {
  tonic: number;
  mode: SynthMode;
  bpm: number;
  seconds: number;
  arc: EnergyArc;
  vocalWindows?: VocalWindowSpec[];
  /** The second the drop lands: [dropAtSec-2, dropAtSec) is quiet. */
  dropAtSec?: number;
  seed?: number;
  /**
   * Harmonic richness of the chord pads (0 = pure sines). Vocal-led
   * songs keep this low and shift the pads an octave down so the
   * non-vocal windows stay out of the vocal band.
   */
  harmonicLevel?: number;
  /** Octave shift for the chord-pad root band (0 = midi 48–59). */
  padOctaveShift?: number;
  clickAmp?: number;
  /** Kick amplitude on accents (0.4 default). */
  kickAmp?: number;
  /** Kick on every beat (a foot-tap / four-on-the-floor grid). */
  kickEveryBeat?: boolean;
  /** Offbeat hats at half-beats (only when 2×bpm > 180). */
  hats?: boolean;
  /** Backbeat snaps on beats 2 and 4 of each bar. */
  backbeat?: boolean;
  masterGain?: number;
  firstBeatSec?: number;
}

/** Arc gain segments as [fromFrac, toFrac, gain] over the duration. */
function arcSegments(arc: EnergyArc): [number, number, number][] {
  switch (arc) {
    case "build":
      return [
        [0, 0.25, 0.35],
        [0.25, 0.5, 0.6],
        [0.5, 0.75, 0.85],
        [0.75, 1, 1],
      ];
    case "loud-quiet-loud":
      return [
        [0, 1 / 3, 1],
        [1 / 3, 2 / 3, 0.16],
        [2 / 3, 1, 1],
      ];
    default:
      return [[0, 1, 0.85]];
  }
}

export function harmonicSong(opts: HarmonicSongOptions): Float32Array {
  const sr = SYNTH_SAMPLE_RATE;
  const buf = new Float32Array(Math.round(opts.seconds * sr));
  const rng = mulberry32(opts.seed ?? 1);
  const clickAmp = opts.clickAmp ?? 0.8;
  const firstBeatSec = opts.firstBeatSec ?? 0.3;
  const harmonicLevel = opts.harmonicLevel ?? 1;

  // Chord pads.
  const padBase = rootMidiInRange(
    opts.tonic,
    48 + (opts.padOctaveShift ?? 0) * 12,
    60 + (opts.padOctaveShift ?? 0) * 12,
  );
  layChordBars(buf, sr, {
    tonic: opts.tonic,
    mode: opts.mode,
    bpm: opts.bpm,
    baseRootMidi: padBase,
    harmonicLevel,
    toneAmp: 0.11,
  });
  layBassline(buf, sr, {
    tonic: opts.tonic,
    mode: opts.mode,
    bpm: opts.bpm,
    amp: 0.15,
  });

  // Beat grid (clicks/kicks are added AFTER the pump below, so the
  // transients themselves stay at full strength).
  const beats = beatTimes(opts.bpm, opts.seconds, firstBeatSec, 0);

  // Vocal windows: sustained chord-tone stacks centred near 800 Hz
  // with vibrato — formant-ish energy that stays on the chord, so
  // the chroma and the vocal measurement agree with the planting.
  // The stack FOLLOWS the chord progression bar by bar inside the
  // window (a singer sings over the changes, not over one chord).
  const progression = progressionFor(opts.mode);
  const barSec = (4 * 60) / opts.bpm;
  for (const win of opts.vocalWindows ?? []) {
    const firstBar = Math.max(
      0,
      Math.floor((win.startSec - firstBeatSec) / barSec),
    );
    const lastBar = Math.floor((win.endSec - firstBeatSec) / barSec);
    for (let b = firstBar; b <= lastBar; b += 1) {
      const segFrom = Math.max(win.startSec, firstBeatSec + b * barSec);
      const segTo = Math.min(win.endSec, firstBeatSec + (b + 1) * barSec);
      if (segTo <= segFrom) continue;
      const chord = progression[b % progression.length];
      const root = chordRootMidi(rootMidiInRange(opts.tonic, 48, 60), chord);
      const chordMidis = [root, root + chord.third, root + chord.fifth];
      for (const m0 of chordMidis) {
        let m = m0;
        while (m < 72) m += 12;
        while (m > 84) m -= 12;
        const freq = freqOfMidi(m);
        // Bell weight peaking near 800 Hz.
        const bell = 0.55 + 0.45 * Math.exp(-Math.pow((freq - 800) / 520, 2));
        addTone(buf, sr, {
          freq,
          amp: 0.16 * bell,
          fromSec: segFrom,
          toSec: segTo,
          vibratoDepth: 0.003,
          vibratoHz: 5.2 + (m % 3),
          phase0: m * 0.11,
        });
        addTone(buf, sr, {
          freq: freq * 1.003,
          amp: 0.1 * bell,
          fromSec: segFrom,
          toSec: segTo,
          vibratoDepth: 0.003,
          vibratoHz: 5.6 + (m % 2),
          phase0: m * 0.23,
        });
        // One octave down, still in-band (>= ~260 Hz at midi 60+).
        if (m - 12 >= 60) {
          addTone(buf, sr, {
            freq: freqOfMidi(m - 12),
            amp: 0.09 * bell,
            fromSec: segFrom,
            toSec: segTo,
            vibratoDepth: 0.0025,
            vibratoHz: 4.9,
            phase0: m * 0.31,
          });
        }
      }
    }
  }

  // Pump the sustained layers (pads + bass + vocals) against the
  // grid, then add the percussive grid itself at full strength.
  applyBeatPump(buf, sr, beats, 0.55, 1.7);
  const kickAmp = opts.kickAmp ?? 0.4;
  beats.forEach((t, i) => {
    const accent = i % 4 === 0;
    addClick(buf, sr, rng, t, accent ? clickAmp : clickAmp * 0.62);
    if (accent || opts.kickEveryBeat) {
      addKick(buf, sr, t, accent ? kickAmp : kickAmp * 0.8);
    }
  });
  addGridFurniture(buf, sr, rng, beats, {
    hats: opts.hats ?? false,
    backbeat: opts.backbeat ?? false,
  });

  // Energy arc + planted drop, applied as a per-sample gain.
  const segments = arcSegments(opts.arc);
  const dropAt = opts.dropAtSec;
  const seconds = opts.seconds;
  const rampSec = 0.25;
  const gainAt = (t: number): number => {
    let gain = segments[segments.length - 1][2];
    for (let s = 0; s < segments.length; s += 1) {
      const [fromF, toF, g] = segments[s];
      const from = fromF * seconds;
      const to = toF * seconds;
      if (t >= from && t < to) {
        gain = g;
        // Smooth the step from the previous segment over rampSec.
        if (s > 0 && t - from < rampSec) {
          const prev = segments[s - 1][2];
          const k = (t - from) / rampSec;
          gain = prev + (g - prev) * k;
        }
        break;
      }
    }
    if (dropAt !== undefined && t >= dropAt - 2 && t < dropAt) {
      // Quiet bar before the drop, with fast (30 ms) edges.
      const edge = 0.03;
      let mute = 0.12;
      if (t - (dropAt - 2) < edge)
        mute = 1 - (1 - 0.12) * ((t - (dropAt - 2)) / edge);
      gain *= mute;
    }
    return gain;
  };
  for (let i = 0; i < buf.length; i += 1) {
    buf[i] *= gainAt(i / sr);
  }

  const master = opts.masterGain ?? 1;
  if (master !== 1) {
    for (let i = 0; i < buf.length; i += 1) buf[i] *= master;
  }
  softCeiling(buf);
  return buf;
}

// ---------------------------------------------------------------------
// breakTrack — a drum-break archetype (Wave 7 fixture addition)
// ---------------------------------------------------------------------
//
// Structure, in beats: a head BREAK (breakBeats), a full BODY
// (bassline stack + grid, like gridTrack), and a tail BREAK of the
// same length. A break is hits with air between them — kick/snare
// pattern, no sustained pads — so its energy contour has a low mean
// under high peaks (the transient shape a scratch window needs),
// over a quiet tonic bass sine that keeps the break harmonically
// honest. The head break's final second is hits-free (bass only),
// so the body's entry lands as a measured drop: a full-energy 1 s
// after a near-silent 1 s. The body carries the key/tempo truth;
// the breaks carry the transient truth.

export interface BreakTrackOptions {
  bpm: number;
  seconds: number;
  tonic: number;
  mode: SynthMode;
  /** Break length in beats, at both the head and the tail. */
  breakBeats: number;
  seed?: number;
  firstBeatSec?: number;
}

export function breakTrack(opts: BreakTrackOptions): Float32Array {
  const sr = SYNTH_SAMPLE_RATE;
  const buf = new Float32Array(Math.round(opts.seconds * sr));
  const rng = mulberry32(opts.seed ?? 1);
  const firstBeatSec = opts.firstBeatSec ?? 0.3;
  const beats = beatTimes(opts.bpm, opts.seconds, firstBeatSec, 0);
  const totalBeats = beats.length;
  const breakBeats = opts.breakBeats;
  const bodyStartBeat = breakBeats;
  const bodyEndBeat = totalBeats - breakBeats;
  const timeOfBeat = (b: number): number =>
    b < beats.length ? beats[b] : firstBeatSec + (b * 60) / opts.bpm;
  const bodyStartSec = timeOfBeat(bodyStartBeat);
  const bodyEndSec = timeOfBeat(bodyEndBeat);

  // Sustained body layers, rendered full-length then windowed to
  // the body region (20 ms edge fades at the two cuts).
  const sustained = new Float32Array(buf.length);
  const shift = 0;
  layChordBars(sustained, sr, {
    tonic: opts.tonic,
    mode: opts.mode,
    bpm: opts.bpm,
    baseRootMidi: rootMidiInRange(opts.tonic, 36 + shift, 48 + shift),
    harmonicLevel: 0.7,
    toneAmp: 0.17,
  });
  layBassline(sustained, sr, {
    tonic: opts.tonic,
    mode: opts.mode,
    bpm: opts.bpm,
    amp: 0.2,
    rootLo: 36 + shift,
    rootHi: 48 + shift,
  });
  // Shallow pump only: the body must sit decisively ABOVE the
  // breaks in mean energy (a deep pump ducks the sustained layers
  // to break level between beats and the break->body step — the
  // planted section boundary and drop — disappears).
  applyBeatPump(sustained, sr, beats, 0.35, 2.2);
  const fadeSamples = Math.round(0.02 * sr);
  for (let i = 0; i < buf.length; i += 1) {
    const t = i / sr;
    if (t < bodyStartSec || t >= bodyEndSec) continue;
    let w = 1;
    const fromStart = i - Math.round(bodyStartSec * sr);
    const toEnd = Math.round(bodyEndSec * sr) - i;
    if (fromStart < fadeSamples) w = Math.min(w, fromStart / fadeSamples);
    if (toEnd < fadeSamples) w = Math.min(w, toEnd / fadeSamples);
    buf[i] += sustained[i] * w;
  }

  // Quiet tonic bass under both breaks (root + fifth, pure sines
  // below the vocal band).
  const bassRoot = rootMidiInRange(opts.tonic, 36, 48);
  for (const [fromSec, toSec] of [
    [0, bodyStartSec],
    [bodyEndSec, opts.seconds],
  ] as const) {
    addTone(buf, sr, {
      freq: freqOfMidi(bassRoot),
      amp: 0.055,
      fromSec,
      toSec,
      phase0: 0.2,
    });
    addTone(buf, sr, {
      freq: freqOfMidi(bassRoot + 7),
      amp: 0.03,
      fromSec,
      toSec,
      phase0: 0.6,
    });
  }

  // Break hits: one bar = kick, snare, kick, snare, with a
  // syncopated extra kick on the "and" of 3 in every second bar.
  // The head break's last second is left hits-free (the drop gap).
  const renderBreak = (
    fromBeat: number,
    toBeat: number,
    gapBeforeSec: number | null,
  ): void => {
    for (let b = fromBeat; b < toBeat; b += 1) {
      const t = timeOfBeat(b);
      if (gapBeforeSec !== null && t > gapBeforeSec - 1.0) continue;
      const inBar = b % 4;
      addClick(buf, sr, rng, t, 0.55);
      if (inBar === 0 || inBar === 2) addKick(buf, sr, t, 0.85);
      if (inBar === 1 || inBar === 3) {
        addNoiseBurst(buf, sr, rng, t, 0.8, 0.09, 0.03);
      }
      if (inBar === 2 && Math.floor(b / 4) % 2 === 1) {
        addKick(buf, sr, t + 30 / opts.bpm, 0.6);
      }
    }
  };
  renderBreak(0, bodyStartBeat, bodyStartSec);
  renderBreak(bodyEndBeat, totalBeats, null);

  // Body percussion: the full grid furniture, body beats only.
  const bodyBeats = beats.slice(bodyStartBeat, bodyEndBeat);
  bodyBeats.forEach((t, i) => {
    const accent = i % 4 === 0;
    addClick(buf, sr, rng, t, accent ? 0.9 : 0.9 * 0.62);
    addKick(buf, sr, t, accent ? 0.5 : 0.5 * 0.8);
  });
  addGridFurniture(buf, sr, rng, bodyBeats, { hats: true, backbeat: true });

  softCeiling(buf);
  return buf;
}
