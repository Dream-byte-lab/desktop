// SPIKE HARNESS — Step 5, slice S5-5 (see timeStretch.ts's header).
//
// This suite is the spike's measuring instrument: synthetic fixtures
// with KNOWN ground truth (a vocal-like signal of known pitch, a
// percussive pattern of known onset times, a layered mix of both),
// every candidate algorithm run over them at the ratios the decision
// profiles would actually spend (the ±4/±6/±9% caps of today, plus
// the ±15% an unlocked stretch would open), and the artefact metrics
// from timeStretch.ts read off the results. Every measurement is
// printed (SPIKE-MEASURE lines) so the slice report quotes the suite's
// own output, and the assertions pin the measured behaviour so a
// future change to any candidate moves the battery, not just a doc.
//
// Timings are printed, never asserted (this VM's speed is not the
// user's ARM Surface's; the report does the labelled conversion).

import { describe, expect, it } from "vitest";
import {
  achievedFactor,
  centsBetween,
  dominantSpectralPeakHz,
  envelopeWobble,
  estimateMedianPitchHz,
  rateShiftChannel,
  steadySpectralFlux,
  stretchOlaChannel,
  stretchPhaseVocoderChannel,
  stretchWithSoundTouch,
  transientMeasures,
} from "./timeStretch";

const SAMPLE_RATE = 44100;

function measure(label: string, data: Record<string, number>): void {
  const rounded: Record<string, number> = {};
  for (const [k, v] of Object.entries(data)) {
    rounded[k] = Math.round(v * 1000) / 1000;
  }
  console.info(`SPIKE-MEASURE ${label} ${JSON.stringify(rounded)}`);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A vocal-like sustained signal: a 220 Hz harmonic stack with
 * formant-shaped amplitudes, ±0.5% vibrato at 5 Hz and a slow 15%
 * tremolo — steady enough that a perfect stretch changes almost
 * nothing frame to frame, pitched enough that a pitch error is a
 * number, not an opinion.
 */
function vocalFixture(seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  const f0 = 220;
  const harmonics = 14;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    // Vibrato integrated into the phase: phase = 2πf∫(1 + d·sin(2πrt))dt,
    // so the instantaneous frequency truly is f0·(1 + d·sin(2πrt)) —
    // writing f0·vibrato·t instead would let the frequency error grow
    // linearly with t and the fixture's ground truth would be a lie.
    const phaseBase =
      t + (0.005 / (2 * Math.PI * 5)) * (1 - Math.cos(2 * Math.PI * 5 * t));
    const tremolo = 1 + 0.15 * Math.sin(2 * Math.PI * 0.35 * t);
    let v = 0;
    for (let h = 1; h <= harmonics; h += 1) {
      const formant =
        Math.exp(-((h - 3) ** 2) / 18) * 0.7 +
        Math.exp(-((h - 8) ** 2) / 8) * 0.4;
      const amp = formant / h ** 0.7;
      v += amp * Math.sin(2 * Math.PI * f0 * h * phaseBase + h * 0.3);
    }
    const edge = Math.min(1, t / 0.1, (seconds - t) / 0.1);
    out[i] = 0.24 * tremolo * edge * v;
  }
  return out;
}

/**
 * A percussive pattern at 120 BPM: a pitched kick thump on every
 * beat (onsets are ground truth) and a short noise hat on every
 * offbeat. Transients are the phase vocoder's known weakness and the
 * time-domain algorithms' home turf.
 */
function percussiveFixture(seconds: number): {
  samples: Float32Array;
  kickOnsetsSec: number[];
} {
  const out = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  const onsets: number[] = [];
  let seed = 22222;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648 - 0.5;
  };
  const beatSec = 0.5;
  for (let beat = 0; beat * beatSec < seconds - 0.3; beat += 1) {
    const t0 = 0.25 + beat * beatSec;
    onsets.push(t0);
    const start = Math.floor(t0 * SAMPLE_RATE);
    for (let n = 0; n < 0.16 * SAMPLE_RATE; n += 1) {
      const t = n / SAMPLE_RATE;
      const phase =
        2 * Math.PI * (55 * t + 105 * 0.018 * (1 - Math.exp(-t / 0.018)));
      out[start + n] += 0.85 * Math.exp(-t / 0.055) * Math.sin(phase);
    }
    const hatStart = Math.floor((t0 + 0.25) * SAMPLE_RATE);
    let prev = 0;
    for (let n = 0; n < 0.008 * SAMPLE_RATE; n += 1) {
      const noise = rand();
      out[hatStart + n] += 0.22 * (noise - prev) * Math.exp(-n / 60);
      prev = noise;
    }
  }
  return { samples: out, kickOnsetsSec: onsets };
}

/** A layered mix: kick pattern + steady bass + a vocal-like lead. */
function mixFixture(seconds: number): {
  samples: Float32Array;
  kickOnsetsSec: number[];
} {
  const { samples, kickOnsetsSec } = percussiveFixture(seconds);
  const out = new Float32Array(samples);
  for (let i = 0; i < out.length; i += 1) out[i] *= 0.7;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    let bass = 0;
    for (let h = 1; h <= 4; h += 1) {
      bass += (0.16 / h) * Math.sin(2 * Math.PI * 98 * h * t);
    }
    const leadPhase =
      t + (0.005 / (2 * Math.PI * 5.2)) * (1 - Math.cos(2 * Math.PI * 5.2 * t));
    let lead = 0;
    for (let h = 1; h <= 10; h += 1) {
      lead += (0.11 / h ** 0.8) * Math.sin(2 * Math.PI * 330 * h * leadPhase);
    }
    const leadIn = Math.min(1, Math.max(0, (t - 0.5) / 0.2));
    out[i] += bass + lead * leadIn;
  }
  return { samples: out, kickOnsetsSec };
}

// ---------------------------------------------------------------------------
// Runners shared by the suites
// ---------------------------------------------------------------------------

type Algorithm = "soundtouch" | "phase-vocoder" | "ola" | "rate-shift";

function runMono(
  algorithm: Algorithm,
  samples: Float32Array,
  k: number,
): Float32Array {
  switch (algorithm) {
    case "soundtouch":
      return stretchWithSoundTouch([samples], SAMPLE_RATE, k)[0];
    case "phase-vocoder":
      return stretchPhaseVocoderChannel(samples, k);
    case "ola":
      return stretchOlaChannel(samples, k);
    case "rate-shift":
      return rateShiftChannel(samples, k);
  }
}

function pitchCents(
  samples: Float32Array,
  referenceHz: number,
  minHz: number,
  maxHz: number,
): number {
  const durationSec = samples.length / SAMPLE_RATE;
  const hz = estimateMedianPitchHz(samples, SAMPLE_RATE, {
    minHz,
    maxHz,
    fromSec: durationSec * 0.15,
    toSec: durationSec * 0.85,
  });
  return centsBetween(hz, referenceHz);
}

const RATIOS = [0.85, 0.91, 0.94, 1.06, 1.09, 1.15];

// ---------------------------------------------------------------------------
// Duration honesty: a stretch that lies about its factor is useless
// to a beat grid, whatever it sounds like.
// ---------------------------------------------------------------------------

describe("timeStretch spike — duration", () => {
  it(
    "every candidate lands within 2% of the requested tempo factor",
    { timeout: 60000 },
    () => {
      const fixture = vocalFixture(6);
      for (const algorithm of [
        "soundtouch",
        "phase-vocoder",
        "ola",
        "rate-shift",
      ] as Algorithm[]) {
        for (const k of [0.91, 1.09]) {
          const out = runMono(algorithm, fixture, k);
          const achieved = achievedFactor(fixture.length, out.length);
          measure(`duration ${algorithm} k=${k}`, { achieved });
          expect(Math.abs(achieved - k)).toBeLessThan(0.02);
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Pitch: the whole question. The baseline MUST show the theoretical
// error (that is the disease); a real stretch must hold the pitch.
// ---------------------------------------------------------------------------

describe("timeStretch spike — pitch preservation", () => {
  it(
    "the rate-shift baseline moves pitch by exactly the tempo factor",
    { timeout: 60000 },
    () => {
      const fixture = vocalFixture(8);
      for (const k of [0.91, 1.09]) {
        const out = rateShiftChannel(fixture, k);
        const cents = pitchCents(out, 220, 170, 285);
        measure(`pitch rate-shift k=${k}`, { cents });
        expect(Math.abs(cents - centsBetween(k, 1))).toBeLessThan(18);
      }
    },
  );

  it(
    "SoundTouch holds pitch across the profile range and the extended range",
    { timeout: 120000 },
    () => {
      const fixture = vocalFixture(8);
      for (const k of RATIOS) {
        const out = stretchWithSoundTouch([fixture], SAMPLE_RATE, k)[0];
        const cents = pitchCents(out, 220, 170, 285);
        measure(`pitch soundtouch k=${k}`, { cents });
        expect(Math.abs(cents)).toBeLessThan(45);
      }
    },
  );

  it(
    "the phase vocoder holds pitch; naive OLA provably does not (the control)",
    { timeout: 120000 },
    () => {
      const fixture = vocalFixture(8);
      for (const k of [0.91, 1.09, 1.15]) {
        const pv = pitchCents(
          stretchPhaseVocoderChannel(fixture, k),
          220,
          170,
          285,
        );
        measure(`pitch phase-vocoder k=${k}`, { cents: pv });
        expect(Math.abs(pv)).toBeLessThan(45);
      }
      // Measured +206 cents at k=1.09: without an alignment search the
      // grains repeat at their own period and the tracker (like an
      // ear) locks onto the doubling. This assertion pins the failure
      // — it is the evidence for what the alignment search buys.
      const ola = pitchCents(stretchOlaChannel(fixture, 1.09), 220, 170, 285);
      measure("pitch ola k=1.09", { cents: ola });
      expect(Math.abs(ola)).toBeGreaterThan(100);
    },
  );
});

// ---------------------------------------------------------------------------
// Transients: pre-echo and attack retention at the kick onsets.
// ---------------------------------------------------------------------------

describe("timeStretch spike — transient preservation", () => {
  it(
    "measures smear for every candidate at ±9%, and SoundTouch at ±15%",
    { timeout: 120000 },
    () => {
      const { samples, kickOnsetsSec } = percussiveFixture(8);
      const floor = transientMeasures(samples, SAMPLE_RATE, kickOnsetsSec);
      measure("transient floor (unstretched)", floor);
      for (const k of [0.91, 1.09]) {
        for (const algorithm of [
          "rate-shift",
          "soundtouch",
          "phase-vocoder",
          "ola",
        ] as Algorithm[]) {
          const out = runMono(algorithm, samples, k);
          const achieved = achievedFactor(samples.length, out.length);
          const onsets = kickOnsetsSec.map((t) => t / achieved);
          const m = transientMeasures(out, SAMPLE_RATE, onsets, {
            samples,
            onsetsSec: kickOnsetsSec,
          });
          measure(`transient ${algorithm} k=${k}`, m);
          expect(m.attackRetention).toBeGreaterThan(0.3);
          expect(m.attackRetention).toBeLessThan(1.3);
          if (algorithm === "soundtouch" && k > 1) {
            expect(m.preEchoRatio).toBeLessThan(0.05);
            expect(m.attackRetention).toBeGreaterThan(0.93);
          }
          if (algorithm === "soundtouch" && k < 1) {
            // −9%: retention holds (0.95) but pre-echo is the price
            // (0.44) — the borderline the ear test must judge.
            expect(m.attackRetention).toBeGreaterThan(0.9);
            expect(m.preEchoRatio).toBeLessThan(0.55);
          }
          if (algorithm === "phase-vocoder") {
            // The vocoder's known smear, measured: retention ~0.57.
            expect(m.attackRetention).toBeLessThan(0.7);
          }
        }
      }
      for (const k of [0.85, 1.15]) {
        const out = stretchWithSoundTouch([samples], SAMPLE_RATE, k)[0];
        const achieved = achievedFactor(samples.length, out.length);
        const onsets = kickOnsetsSec.map((t) => t / achieved);
        const m = transientMeasures(out, SAMPLE_RATE, onsets, {
          samples,
          onsetsSec: kickOnsetsSec,
        });
        measure(`transient soundtouch k=${k}`, m);
        if (k > 1) {
          // Speeding up is SoundTouch's clean direction even at 15%:
          // measured pre-echo 0, attack retention 0.96.
          expect(m.preEchoRatio).toBeLessThan(0.05);
          expect(m.attackRetention).toBeGreaterThan(0.93);
        } else {
          // Slowing by 15% is where it provably fails: measured
          // pre-echo 0.94 (the attack's energy smeared ahead of the
          // onset almost as loud as the attack itself). This pins
          // the slow-down limit the verdict draws at −9%.
          expect(m.preEchoRatio).toBeGreaterThan(0.8);
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Phasiness: steady-state flux + envelope wobble on the vocal fixture,
// read as ratios against the unstretched floor.
// ---------------------------------------------------------------------------

describe("timeStretch spike — phasiness proxies", () => {
  it(
    "measures spectral flux and envelope wobble per candidate",
    { timeout: 120000 },
    () => {
      const fixture = vocalFixture(8);
      const durationSec = fixture.length / SAMPLE_RATE;
      const floorFlux = steadySpectralFlux(
        fixture,
        SAMPLE_RATE,
        durationSec * 0.2,
        durationSec * 0.8,
      );
      const floorWobble = envelopeWobble(
        fixture,
        SAMPLE_RATE,
        durationSec * 0.2,
        durationSec * 0.8,
      );
      measure("phasiness floor (unstretched)", {
        flux: floorFlux,
        wobble: floorWobble,
      });
      for (const k of [0.91, 1.09]) {
        for (const algorithm of [
          "rate-shift",
          "soundtouch",
          "phase-vocoder",
          "ola",
        ] as Algorithm[]) {
          const out = runMono(algorithm, fixture, k);
          const d = out.length / SAMPLE_RATE;
          const flux = steadySpectralFlux(out, SAMPLE_RATE, d * 0.2, d * 0.8);
          const wobble = envelopeWobble(out, SAMPLE_RATE, d * 0.2, d * 0.8);
          measure(`phasiness ${algorithm} k=${k}`, {
            flux,
            fluxRatio: flux / floorFlux,
            wobble,
            wobbleRatio: wobble / floorWobble,
          });
          if (algorithm === "soundtouch") {
            // At/below the unstretched floor on both proxies —
            // no measurable phasiness on sustained material.
            expect(flux / floorFlux).toBeLessThan(1.15);
            expect(wobble / floorWobble).toBeLessThan(1.1);
          }
          if (algorithm === "phase-vocoder" && k < 1) {
            // The vocoder's phasiness, measured in the envelope:
            // wobble 1.49× the floor at −9%.
            expect(wobble / floorWobble).toBeGreaterThan(1.3);
          }
        }
      }
    },
  );
});

// ---------------------------------------------------------------------------
// The mix: both artefact families at once, at the standard profile's
// full stretch — the closest a fixture gets to a real blend.
// ---------------------------------------------------------------------------

describe("timeStretch spike — layered mix at +9%", () => {
  it(
    "SoundTouch keeps the lead's pitch and the kick's attack; the baseline keeps only the attack",
    { timeout: 120000 },
    () => {
      const { samples, kickOnsetsSec } = mixFixture(8);
      const k = 1.09;
      for (const algorithm of ["soundtouch", "rate-shift"] as Algorithm[]) {
        const out = runMono(algorithm, samples, k);
        const achieved = achievedFactor(samples.length, out.length);
        const onsets = kickOnsetsSec.map((t) => t / achieved);
        const transients = transientMeasures(out, SAMPLE_RATE, onsets, {
          samples,
          onsetsSec: kickOnsetsSec,
        });
        const d = out.length / SAMPLE_RATE;
        const peakHz = dominantSpectralPeakHz(out, SAMPLE_RATE, {
          minHz: 300,
          maxHz: 360,
          fromSec: d * 0.2,
          toSec: d * 0.8,
        });
        const cents = centsBetween(peakHz, 330);
        measure(`mix ${algorithm} k=${k}`, { ...transients, leadCents: cents });
        if (algorithm === "soundtouch") {
          expect(Math.abs(cents)).toBeLessThan(60);
        } else {
          expect(Math.abs(cents)).toBeGreaterThan(100);
        }
      }
    },
  );
});

describe("timeStretch spike — SoundTouch quickSeek (fast mode) quality", () => {
  it(
    "prints pitch/transient/flux for quickSeek=true at ±9%",
    { timeout: 120000 },
    () => {
      const vocal = vocalFixture(8);
      const { samples, kickOnsetsSec } = percussiveFixture(8);
      for (const k of [0.91, 1.09]) {
        const outVocal = stretchWithSoundTouch([vocal], SAMPLE_RATE, k, {
          quickSeek: true,
        })[0];
        const cents = pitchCents(outVocal, 220, 170, 285);
        const d = outVocal.length / SAMPLE_RATE;
        const flux = steadySpectralFlux(
          outVocal,
          SAMPLE_RATE,
          d * 0.2,
          d * 0.8,
        );
        const outPerc = stretchWithSoundTouch([samples], SAMPLE_RATE, k, {
          quickSeek: true,
        })[0];
        const achieved = achievedFactor(samples.length, outPerc.length);
        const onsets = kickOnsetsSec.map((t) => t / achieved);
        const transients = transientMeasures(outPerc, SAMPLE_RATE, onsets, {
          samples,
          onsetsSec: kickOnsetsSec,
        });
        measure(`quickseek soundtouch k=${k}`, { cents, flux, ...transients });
        expect(Math.abs(cents)).toBeLessThan(45);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Stereo + cost: a full-width render at production shape. Timings are
// printed for the report (VM-measured; the report converts honestly),
// never asserted.
// ---------------------------------------------------------------------------

describe("timeStretch spike — stereo render and CPU cost", () => {
  it(
    "renders 20 s of stereo with SoundTouch and the phase vocoder",
    { timeout: 180000 },
    () => {
      const { samples } = mixFixture(20);
      const quieter = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i += 1) quieter[i] = samples[i] * 0.8;
      const stereo = [samples, quieter];
      const k = 1.09;

      for (const quickSeek of [false, true]) {
        const t0 = performance.now();
        const out = stretchWithSoundTouch(stereo, SAMPLE_RATE, k, {
          quickSeek,
        });
        const ms = performance.now() - t0;
        measure(`cpu soundtouch 20s stereo quickSeek=${quickSeek}`, {
          ms,
          perMinuteMs: ms * 3,
          realtimeFactor: 20000 / ms,
          achieved: achievedFactor(samples.length, out[0].length),
        });
        expect(out).toHaveLength(2);
        expect(
          Math.abs(achievedFactor(samples.length, out[0].length) - k),
        ).toBeLessThan(0.02);
      }

      const t0 = performance.now();
      const pvLeft = stretchPhaseVocoderChannel(samples, k);
      const pvRight = stretchPhaseVocoderChannel(quieter, k);
      const ms = performance.now() - t0;
      measure("cpu phase-vocoder 20s stereo", {
        ms,
        perMinuteMs: ms * 3,
        realtimeFactor: 20000 / ms,
        achieved: achievedFactor(samples.length, pvLeft.length),
      });
      expect(pvRight.length).toBe(pvLeft.length);
    },
  );
});
