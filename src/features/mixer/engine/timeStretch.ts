// ============================================================================
// SPIKE — Step 5, slice S5-5: the time-stretch go/no-go spike.
//
// THIS FILE IS NOT WIRED TO ANY PRODUCTION PATH. Nothing imports it
// except its own test suite (timeStretch.test.ts), which is the spike
// harness. It exists so requirement 4 of the Step 5 charter — "pitch-
// independent tempo, or none" — is answered by measurement, not hope.
// The verdict, the numbers, and the integration design (if GO) live in
// investigation/step5-slice-s5-5.md. If the verdict is NO-GO this file
// is the documented negative result the blueprint (§4.4) asks for; if
// GO, this file loses the SPIKE fence and becomes the stretch renderer
// behind the preparation layer — the deck itself never changes.
//
// THE QUESTION: can this app change a track's tempo WITHOUT changing
// its pitch, at a quality a listener accepts inside a blend, within
// our Web Audio / Electron stack and a sane CPU budget?
//
// THE CANDIDATES IMPLEMENTED HERE (all offline renders over raw
// channel arrays — offline vs streaming changes latency and memory,
// never an algorithm's artefacts):
//
//   1. stretchWithSoundTouch — the SoundTouch algorithm (time-domain
//      overlap-add with cross-correlation alignment search; the
//      WSOLA family) via the "soundtouchjs" package, which is
//      ALREADY a production dependency of this app (LGPL-2.1). This
//      is the "existing library" route, evaluated in code, not just
//      on paper.
//   2. stretchWithPhaseVocoder — a textbook Laroche phase vocoder
//      (STFT → per-bin true-frequency phase propagation → ISTFT),
//      the algorithm an AudioWorklet implementation would run. Its
//      own FFT is included below; the tree has none.
//   3. stretchWithOla — naive overlap-add with NO alignment search:
//      the control that shows what the alignment search buys.
//   4. rateShift — the honest baseline, what playbackRate does today:
//      linear-interpolation resampling. Perfect transients, pitch
//      moved by exactly the tempo factor. Every candidate is judged
//      against this.
//
// RATIO VOCABULARY: a tempo factor k means "play at k × the tempo":
// output duration = input duration / k, and k is exactly the number
// today's recipes carry as rateB (= bpmA / bpmB for a beatmatch).
// k = 1.09 is a 9% speed-up; k = 0.91 a 9% slow-down.
//
// THE METRICS (exported at the bottom, all pure): pitch error in
// cents on a sustained vocal-like signal; transient pre-echo ratio
// and attack retention on a percussive signal; steady-state spectral
// flux and envelope wobble as phasiness proxies. The fixtures that
// feed them live in the test suite.
// ============================================================================

import { SimpleFilter, SoundTouch } from "soundtouchjs";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function hannWindow(length: number): Float32Array {
  const w = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
  }
  return w;
}

/** Iterative radix-2 FFT, in place. Length must be a power of two. */
function fftInPlace(
  re: Float32Array,
  im: Float32Array,
  inverse: boolean,
): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((2 * Math.PI) / len) * (inverse ? 1 : -1);
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < half; j += 1) {
        const ur = re[i + j];
        const ui = im[i + j];
        const vr = re[i + j + half] * cwr - im[i + j + half] * cwi;
        const vi = re[i + j + half] * cwi + im[i + j + half] * cwr;
        re[i + j] = ur + vr;
        im[i + j] = ui + vi;
        re[i + j + half] = ur - vr;
        im[i + j + half] = ui - vi;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate 4 (the baseline): rate shift — what playbackRate does today.
// Linear-interpolation resampling: duration / rate, pitch × rate.
// ---------------------------------------------------------------------------

export function rateShiftChannel(
  samples: Float32Array,
  rate: number,
): Float32Array {
  const outLength = Math.max(1, Math.floor(samples.length / rate));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * rate;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[Math.min(idx, samples.length - 1)];
    const b = samples[Math.min(idx + 1, samples.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidate 3 (the control): naive overlap-add, no alignment search.
// Fixed grains of `grainSize` Hann-windowed samples are laid down every
// `outHop` output samples while the read cursor advances by
// outHop × tempoFactor input samples. Nothing checks that the grains
// agree in phase where they overlap — the doubling / chorusing this
// produces is exactly what a WSOLA alignment search exists to prevent.
// ---------------------------------------------------------------------------

export function stretchOlaChannel(
  samples: Float32Array,
  tempoFactor: number,
  grainSize = 2048,
  outHop = 256,
): Float32Array {
  const win = hannWindow(grainSize);
  const outLength = Math.floor(samples.length / tempoFactor) + grainSize;
  const out = new Float32Array(outLength);
  const envelope = new Float32Array(outLength);
  let cursor = 0;
  for (let outPos = 0; outPos + grainSize < outLength; outPos += outHop) {
    const start = Math.round(cursor);
    if (start + grainSize > samples.length) break;
    for (let i = 0; i < grainSize; i += 1) {
      out[outPos + i] += samples[start + i] * win[i];
      envelope[outPos + i] += win[i];
    }
    cursor += outHop * tempoFactor;
  }
  for (let i = 0; i < outLength; i += 1) {
    if (envelope[i] > 1e-4) out[i] /= envelope[i];
  }
  return out.subarray(0, Math.floor(samples.length / tempoFactor));
}

// ---------------------------------------------------------------------------
// Candidate 2: the phase vocoder (textbook Laroche form, no phase
// locking — the honest representative of its class). STFT with a
// 2048-sample Hann window and a 512-sample analysis hop; the synthesis
// hop is 512 / tempoFactor rounded to an integer, so the achieved
// factor is 512 / synthesisHop (within ~0.1% of the request at the
// ratios this spike tests — the metrics read the achieved factor from
// the output length, never from the request).
// ---------------------------------------------------------------------------

const PV_WINDOW = 2048;
const PV_ANALYSIS_HOP = 512;

export function stretchPhaseVocoderChannel(
  samples: Float32Array,
  tempoFactor: number,
): Float32Array {
  const n = PV_WINDOW;
  const ra = PV_ANALYSIS_HOP;
  const rs = Math.max(32, Math.round(ra / tempoFactor));
  const win = hannWindow(n);
  const padded = new Float32Array(samples.length + 2 * n);
  padded.set(samples, n);

  const frameCount = Math.floor((padded.length - n) / ra);
  const outCapacity = Math.ceil(padded.length * (rs / ra)) + n;
  const out = new Float32Array(outCapacity);
  const envelope = new Float32Array(outCapacity);

  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const mag = new Float32Array(n);
  let prevPhase: Float32Array | null = null;
  let synthPhase: Float32Array | null = null;

  let outPos = 0;
  for (let frame = 0; frame <= frameCount; frame += 1) {
    const start = frame * ra;
    for (let i = 0; i < n; i += 1) {
      re[i] = padded[start + i] * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im, false);
    const phase = new Float32Array(n);
    for (let k = 0; k < n; k += 1) {
      mag[k] = Math.hypot(re[k], im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }
    if (prevPhase === null || synthPhase === null) {
      synthPhase = phase.slice();
    } else {
      for (let k = 0; k < n; k += 1) {
        const expected = (2 * Math.PI * ra * k) / n;
        let delta = phase[k] - prevPhase[k] - expected;
        delta -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
        const trueAdvance = expected / ra + delta / ra; // radians per sample
        synthPhase[k] += trueAdvance * rs;
      }
    }
    prevPhase = phase;
    for (let k = 0; k < n; k += 1) {
      re[k] = mag[k] * Math.cos(synthPhase[k]);
      im[k] = mag[k] * Math.sin(synthPhase[k]);
    }
    fftInPlace(re, im, true);
    for (let i = 0; i < n; i += 1) {
      out[outPos + i] += re[i] * win[i];
      envelope[outPos + i] += win[i] * win[i];
    }
    outPos += rs;
  }
  for (let i = 0; i < outCapacity; i += 1) {
    if (envelope[i] > 1e-4) out[i] /= envelope[i];
  }
  const startOut = Math.round(n * (rs / ra));
  const want = Math.round(samples.length * (rs / ra));
  return out.slice(startOut, startOut + want);
}

// ---------------------------------------------------------------------------
// Candidate 1: SoundTouch via soundtouchjs (the library route).
//
// The library's pipeline is a pull model over interleaved stereo: a
// source object with extract(target, numFrames, position), a
// SoundTouch pipe, and a SimpleFilter. WebAudioBufferSource (the
// library's own source) needs a real AudioBuffer; the spike feeds the
// identical interface from raw channel arrays instead — same pipe,
// same algorithm, no Web Audio objects involved.
// ---------------------------------------------------------------------------

class ChannelArraySource {
  constructor(private readonly channels: readonly Float32Array[]) {}

  extract(target: Float32Array, numFrames = 0, position = 0): number {
    const left = this.channels[0];
    const right = this.channels[1] ?? left;
    const frames = Math.max(
      0,
      Math.min(numFrames, left.length - position, right.length - position),
    );
    for (let i = 0; i < frames; i += 1) {
      target[i * 2] = left[position + i];
      target[i * 2 + 1] = right[position + i];
    }
    return frames;
  }
}

export interface SoundTouchOptions {
  /**
   * The JS port defaults quickSeek ON (fast, coarser overlap search);
   * the C++ library's quality default is OFF. The spike measures the
   * quality mode; the report prices both.
   */
  quickSeek?: boolean;
}

/**
 * Stretches channel arrays (1 or 2 channels) to `tempoFactor` × the
 * tempo, pitch held, with the SoundTouch algorithm. Returns new
 * channel arrays of EXACTLY round(inputLength / tempoFactor) frames.
 *
 * Two properties of the JS port shape this wrapper, both measured by
 * the spike (probe evidence in the slice report):
 *
 * 1. THE INTERIOR TEMPO IS EXACT. Beats inside the render sit at the
 *    requested tempo's positions to within ~±11 ms worst-case local
 *    placement play (onset residuals over a 12 s percussive fixture,
 *    no accumulation with time). The naive length check lies about
 *    this — see 2.
 * 2. THE PULL PIPELINE DROPS THE TAIL. The C++ library flushes its
 *    last sequences via finish(); the JS port has no finish(), and
 *    extraction simply runs dry ~2% of the input early — the final
 *    ~2% of the track never emerges, which masquerades as a 2–3%
 *    tempo error if output length is all you measure. The wrapper
 *    therefore appends a silence pad (3% of the input + 0.5 s) that
 *    flushes the real tail through, then trims the result to the
 *    mathematically exact output length. The pad's own stretched
 *    silence lands entirely in the trimmed region.
 */
export function stretchWithSoundTouch(
  channels: readonly Float32Array[],
  sampleRate: number,
  tempoFactor: number,
  options: SoundTouchOptions = {},
): Float32Array[] {
  const inputLength = channels[0].length;
  const padFrames = Math.ceil(inputLength * 0.03) + Math.floor(sampleRate / 2);
  const padded = channels.map((channel) => {
    const withPad = new Float32Array(inputLength + padFrames);
    withPad.set(channel);
    return withPad;
  });
  const pipe = new SoundTouch();
  pipe.tempo = tempoFactor;
  // 0 = the library's tempo-adaptive automatic sequence/seek lengths;
  // overlap keeps the library's 8 ms default. The sample rate must be
  // set explicitly — the stage otherwise assumes 44 100 Hz.
  pipe.stretch.setParameters(sampleRate, 0, 0, 8);
  pipe.stretch.quickSeek = options.quickSeek ?? false;
  const filter = new SimpleFilter(new ChannelArraySource(padded), pipe);

  const chunkFrames = 4096;
  const chunk = new Float32Array(chunkFrames * 2);
  const pieces: Float32Array[] = [];
  let totalFrames = 0;
  for (;;) {
    const frames = filter.extract(chunk, chunkFrames);
    if (frames <= 0) break;
    pieces.push(chunk.slice(0, frames * 2));
    totalFrames += frames;
    if (totalFrames > inputLength * 4) {
      throw new Error("soundtouch extraction runaway");
    }
  }
  const wantFrames = Math.round(inputLength / tempoFactor);
  const frames = Math.min(wantFrames, totalFrames);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let offset = 0;
  for (const piece of pieces) {
    const pieceFrames = piece.length / 2;
    for (let i = 0; i < pieceFrames && offset + i < frames; i += 1) {
      left[offset + i] = piece[i * 2];
      right[offset + i] = piece[i * 2 + 1];
    }
    offset += pieceFrames;
    if (offset >= frames) break;
  }
  return channels.length > 1 ? [left, right] : [left];
}

// ---------------------------------------------------------------------------
// Metrics — the artefact proxies the verdict stands on. All pure
// functions over sample arrays; the fixtures live in the test suite.
// ---------------------------------------------------------------------------

/** The tempo factor a render actually achieved, from lengths alone. */
export function achievedFactor(
  inputLength: number,
  outputLength: number,
): number {
  return inputLength / outputLength;
}

/** Pitch distance in cents between two frequencies. */
export function centsBetween(freqHz: number, referenceHz: number): number {
  return 1200 * Math.log2(freqHz / referenceHz);
}

function rmsRange(samples: Float32Array, from: number, to: number): number {
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(samples.length, Math.ceil(to));
  if (b <= a) return 0;
  let sum = 0;
  for (let i = a; i < b; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (b - a));
}

/**
 * Median windowed pitch estimate (normalised autocorrelation over the
 * lag range for [minHz, maxHz], parabolically refined). The same
 * evidence family the analyser's voicedness pass uses — a pitch
 * tracker this app already trusts, pointed at the spike's fixtures.
 */
export function estimateMedianPitchHz(
  samples: Float32Array,
  sampleRate: number,
  options: { minHz: number; maxHz: number; fromSec: number; toSec: number },
): number {
  const winLen = Math.floor(sampleRate * 0.12);
  const hop = Math.floor(sampleRate * 0.06);
  const minLag = Math.floor(sampleRate / options.maxHz);
  const maxLag = Math.ceil(sampleRate / options.minHz);
  const estimates: number[] = [];
  const from = Math.floor(options.fromSec * sampleRate);
  const to = Math.min(
    samples.length - winLen,
    Math.floor(options.toSec * sampleRate),
  );
  for (let start = from; start < to; start += hop) {
    let energy = 0;
    for (let i = 0; i < winLen; i += 1) energy += samples[start + i] ** 2;
    if (energy < 1e-6) continue;
    let bestLag = -1;
    let bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let corr = 0;
      let a = 0;
      let b = 0;
      for (let i = 0; i + lag < winLen; i += 1) {
        corr += samples[start + i] * samples[start + i + lag];
        a += samples[start + i] ** 2;
        b += samples[start + i + lag] ** 2;
      }
      const norm = corr / Math.sqrt(Math.max(1e-12, a * b));
      if (norm > bestCorr) {
        bestCorr = norm;
        bestLag = lag;
      }
    }
    if (bestLag > 0 && bestCorr > 0.5) {
      estimates.push(sampleRate / bestLag);
    }
  }
  if (estimates.length === 0) return Number.NaN;
  estimates.sort((x, y) => x - y);
  return estimates[Math.floor(estimates.length / 2)];
}

/**
 * Transient smear, measured at known onset times (given in the
 * STRETCHED signal's timeline):
 *
 * - preEchoRatio: RMS in the 25 ms BEFORE the onset (excluding the
 *   final 3 ms) over RMS in the 30 ms after it. A clean transient has
 *   ~no energy before itself; smearing (phase vocoder above all)
 *   leaks the attack backwards in time and this ratio climbs.
 * - attackRetention: the peak |sample| around the onset, relative to
 *   the same onset's peak in the reference (unstretched) signal —
 *   smearing spreads the attack's energy over time and the peak sags.
 */
export function transientMeasures(
  samples: Float32Array,
  sampleRate: number,
  onsetsSec: readonly number[],
  reference?: { samples: Float32Array; onsetsSec: readonly number[] },
): { preEchoRatio: number; attackRetention: number } {
  const preFrom = -0.025 * sampleRate;
  const preTo = -0.003 * sampleRate;
  const postTo = 0.03 * sampleRate;
  let preEchoSum = 0;
  let counted = 0;
  onsetsSec.forEach((t, i) => {
    const at = t * sampleRate;
    const pre = rmsRange(samples, at + preFrom, at + preTo);
    const post = rmsRange(samples, at, at + postTo);
    if (post > 1e-5) {
      preEchoSum += pre / post;
      counted += 1;
    }
    void i;
  });
  let retention = 1;
  if (reference) {
    const ratios: number[] = [];
    onsetsSec.forEach((t, i) => {
      const refT = reference.onsetsSec[i];
      if (refT === undefined) return;
      const peakOf = (sig: Float32Array, at: number) => {
        let peak = 0;
        const a = Math.max(0, Math.floor(at - 0.003 * sampleRate));
        const b = Math.min(sig.length, Math.ceil(at + 0.025 * sampleRate));
        for (let j = a; j < b; j += 1) peak = Math.max(peak, Math.abs(sig[j]));
        return peak;
      };
      const got = peakOf(samples, t * sampleRate);
      const want = peakOf(reference.samples, refT * sampleRate);
      if (want > 1e-5) ratios.push(got / want);
    });
    if (ratios.length > 0) {
      retention = ratios.reduce((s, v) => s + v, 0) / ratios.length;
    }
  }
  return {
    preEchoRatio: counted > 0 ? preEchoSum / counted : 0,
    attackRetention: retention,
  };
}

/**
 * The dominant spectral peak in a band, from the long-term average
 * magnitude spectrum over a passage (parabolically refined). Where
 * autocorrelation pitch tracking drowns in a dense mixture, the
 * averaged spectrum still shows where a lead line's fundamental sits
 * — this is the mix fixture's pitch witness.
 */
export function dominantSpectralPeakHz(
  samples: Float32Array,
  sampleRate: number,
  options: { minHz: number; maxHz: number; fromSec: number; toSec: number },
): number {
  const n = 2048;
  const hop = 1024;
  const win = hannWindow(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const avg = new Float32Array(n / 2);
  let frames = 0;
  const from = Math.floor(options.fromSec * sampleRate);
  const to = Math.min(
    samples.length - n,
    Math.floor(options.toSec * sampleRate),
  );
  for (let start = from; start < to; start += hop) {
    for (let i = 0; i < n; i += 1) {
      re[i] = samples[start + i] * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im, false);
    for (let k = 0; k < n / 2; k += 1) avg[k] += Math.hypot(re[k], im[k]);
    frames += 1;
  }
  if (frames === 0) return Number.NaN;
  const minBin = Math.max(1, Math.floor((options.minHz * n) / sampleRate));
  const maxBin = Math.min(
    n / 2 - 2,
    Math.ceil((options.maxHz * n) / sampleRate),
  );
  let best = minBin;
  for (let k = minBin; k <= maxBin; k += 1) {
    if (avg[k] > avg[best]) best = k;
  }
  const a = avg[best - 1];
  const b = avg[best];
  const c = avg[best + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return ((best + shift) * sampleRate) / n;
}

/**
 * Phasiness proxy 1 — steady-state spectral flux: the mean frame-to-
 * frame change of the normalised magnitude spectrum over a sustained
 * passage. A perfect stretch of a steady tone changes nothing frame
 * to frame (beyond the fixture's own slow tremolo/vibrato, which the
 * unstretched floor measures too); phasiness is the spectrum boiling
 * under a note that should be still, and it shows up here.
 */
export function steadySpectralFlux(
  samples: Float32Array,
  sampleRate: number,
  fromSec: number,
  toSec: number,
): number {
  const n = 2048;
  const hop = 1024;
  const win = hannWindow(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  let prev: Float32Array | null = null;
  let fluxSum = 0;
  let pairs = 0;
  const from = Math.floor(fromSec * sampleRate);
  const to = Math.min(samples.length - n, Math.floor(toSec * sampleRate));
  for (let start = from; start < to; start += hop) {
    for (let i = 0; i < n; i += 1) {
      re[i] = samples[start + i] * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im, false);
    const mag = new Float32Array(n / 2);
    let total = 0;
    for (let k = 0; k < n / 2; k += 1) {
      mag[k] = Math.hypot(re[k], im[k]);
      total += mag[k];
    }
    if (total > 1e-9) {
      for (let k = 0; k < n / 2; k += 1) mag[k] /= total;
      if (prev) {
        let diff = 0;
        for (let k = 0; k < n / 2; k += 1) diff += Math.abs(mag[k] - prev[k]);
        fluxSum += diff;
        pairs += 1;
      }
      prev = mag;
    }
  }
  return pairs > 0 ? fluxSum / pairs : 0;
}

/**
 * Phasiness proxy 2 — envelope wobble: the coefficient of variation
 * of the 10 ms RMS envelope over a sustained passage. Time-domain
 * splicing artefacts (doubling, roughness) and vocoder phasiness both
 * roughen an envelope that should move only with the fixture's slow
 * tremolo; read as a ratio against the unstretched floor.
 */
export function envelopeWobble(
  samples: Float32Array,
  sampleRate: number,
  fromSec: number,
  toSec: number,
): number {
  const hop = Math.floor(sampleRate * 0.01);
  const from = Math.floor(fromSec * sampleRate);
  const to = Math.min(samples.length, Math.floor(toSec * sampleRate));
  const values: number[] = [];
  for (let start = from; start + hop <= to; start += hop) {
    values.push(rmsRange(samples, start, start + hop));
  }
  if (values.length < 4) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  if (mean <= 1e-9) return 0;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}
