import { describe, expect, it } from "vitest";
import {
  ANALYSIS_VERSION,
  analyseSamples,
  audioFingerprint,
  camelotFor,
  mixdownToMono,
} from "./analyse";

const SR = 22050;

/** Deterministic pseudo-noise in [-1, 1) from an integer seed. */
function noiseValue(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function blank(durationSec: number): Float32Array {
  return new Float32Array(Math.round(durationSec * SR));
}

/** Add an exponentially decaying white-noise click at time tSec. */
function addClick(buf: Float32Array, tSec: number, amplitude: number): void {
  const start = Math.round(tSec * SR);
  const length = Math.round(0.025 * SR);
  for (let i = 0; i < length && start + i < buf.length; i += 1) {
    buf[start + i] +=
      amplitude * Math.exp(-90 * (i / SR)) * noiseValue(start + i);
  }
}

function clickTrain(
  durationSec: number,
  bpm: number,
  firstBeatSec = 0.25,
): Float32Array {
  const buf = blank(durationSec);
  const period = 60 / bpm;
  let beat = 0;
  for (let t = firstBeatSec; t < durationSec - 0.05; t += period, beat += 1) {
    addClick(buf, t, beat % 4 === 0 ? 1.0 : 0.62);
  }
  return buf;
}

function addSine(
  buf: Float32Array,
  freq: number,
  amplitude: number,
  fromSec = 0,
  toSec?: number,
): void {
  const from = Math.round(fromSec * SR);
  const to = Math.round((toSec ?? buf.length / SR) * SR);
  for (let i = from; i < to && i < buf.length; i += 1) {
    buf[i] += amplitude * Math.sin(2 * Math.PI * freq * (i / SR));
  }
}

describe("audioFingerprint + mixdownToMono", () => {
  it("is deterministic, and changes with the loudness shape", () => {
    const a = clickTrain(6, 120);
    const b = clickTrain(6, 120);
    expect(audioFingerprint(a, SR)).toBe(audioFingerprint(b, SR));
    const quiet = blank(6);
    addSine(quiet, 220, 0.05);
    expect(audioFingerprint(quiet, SR)).not.toBe(audioFingerprint(a, SR));
  });

  it("mixdown averages the channels", () => {
    const left = new Float32Array([1, 0, -1]);
    const right = new Float32Array([0, 1, -1]);
    expect(Array.from(mixdownToMono(left, right))).toEqual([0.5, 0.5, -1]);
  });
});

describe("analyseSamples — ground truth: click train at 120 BPM", () => {
  const read = analyseSamples(clickTrain(12, 120), SR, { depth: "deep" });

  it("recovers the tempo within ±1 BPM with real confidence", () => {
    expect(read).not.toBeNull();
    console.log(
      `[ground-truth] bpm=${read?.bpm} tempoConf=${read?.tempoConfidence.toFixed(3)} gridConf=${read?.grid.confidence.toFixed(3)}`,
    );
    expect(Math.abs((read?.bpm ?? 0) - 120)).toBeLessThanOrEqual(1);
    expect(read?.tempoConfidence).toBeGreaterThan(0.5);
  });

  it("anchors beats to the planted clicks within ~30 ms", () => {
    const beats = read?.grid.beatsMs ?? [];
    expect(beats.length).toBeGreaterThan(15);
    // Planted clicks: 250 ms + k·500 ms. Every beat should sit
    // within 30 ms of one.
    for (const beat of beats.slice(1, -1)) {
      const nearestClickPhase = Math.abs((((beat - 250) % 500) + 500) % 500);
      const distance = Math.min(nearestClickPhase, 500 - nearestClickPhase);
      expect(distance).toBeLessThanOrEqual(30);
    }
    expect(read?.grid.beatsPerBar).toBe(4);
    expect(read?.grid.downbeatsMs.length).toBeGreaterThan(3);
  });

  it("stamps version, depth and the buffer's own fingerprint", () => {
    const buf = clickTrain(12, 120);
    const r2 = analyseSamples(buf, SR, { depth: "fast" });
    expect(r2?.analysisVersion).toBe(ANALYSIS_VERSION);
    expect(r2?.depth).toBe("fast");
    expect(r2?.audioHash).toBe(audioFingerprint(buf, SR));
    expect(Math.abs((r2?.bpm ?? 0) - 120)).toBeLessThanOrEqual(1);
  });
});

describe("analyseSamples — ground truth: key of an A-minor stack", () => {
  it("reads tonic 9 / minor / 8A with confidence > 0.5", () => {
    const buf = blank(6);
    // A minor triad stack: A2 C3 E3 A3 C4 E4 (pure tones).
    const notes: [number, number][] = [
      [110.0, 0.3],
      [130.81, 0.24],
      [164.81, 0.24],
      [220.0, 0.2],
      [261.63, 0.15],
      [329.63, 0.15],
    ];
    for (const [freq, amp] of notes) addSine(buf, freq, amp);
    const read = analyseSamples(buf, SR, { depth: "deep" });
    console.log(
      `[ground-truth] key=${JSON.stringify(read?.key)} camelotA=${camelotFor(9, "minor")}`,
    );
    expect(read?.key?.tonic).toBe(9);
    expect(read?.key?.mode).toBe("minor");
    expect(read?.key?.camelot).toBe("8A");
    expect(read?.key?.confidence).toBeGreaterThan(0.5);
    expect(camelotFor(0, "major")).toBe("8B");
    expect(camelotFor(9, "minor")).toBe("8A");
  });
});

describe("analyseSamples — ground truth: sections, drops, vocals", () => {
  it("loud–quiet–loud arc yields ≥3 sections, breakdown-ish middle", () => {
    const buf = blank(18);
    addSine(buf, 220, 0.5, 0, 6);
    addSine(buf, 220, 0.06, 6, 12);
    addSine(buf, 220, 0.5, 12, 18);
    const read = analyseSamples(buf, SR, { depth: "deep" });
    console.log(
      `[ground-truth] sections=${JSON.stringify(read?.sections.map((s) => s.kind))}`,
    );
    expect(read?.sections.length ?? 0).toBeGreaterThanOrEqual(3);
    const middle = (read?.sections ?? []).find(
      (s) => s.startMs <= 9000 && s.endMs >= 9000,
    );
    expect(middle?.kind).toBe("breakdown");
  });

  it("a surge after a quiet bar is detected as a drop near its time", () => {
    const buf = blank(12);
    addSine(buf, 180, 0.05, 0, 4);
    addSine(buf, 180, 0.6, 4, 12);
    // Add clicks after the surge so the loud part has body too.
    for (let t = 4; t < 11.5; t += 0.5) addClick(buf, t, 0.7);
    const read = analyseSamples(buf, SR, { depth: "deep" });
    console.log(`[ground-truth] drops=${JSON.stringify(read?.drops)}`);
    expect(read?.drops.length ?? 0).toBeGreaterThanOrEqual(1);
    const nearest = Math.min(
      ...(read?.drops ?? [{ atMs: Infinity }]).map((d) =>
        Math.abs(d.atMs - 4000),
      ),
    );
    expect(nearest).toBeLessThanOrEqual(750);
    expect(read?.drops[0]?.strength).toBeGreaterThan(1.9);
  });

  it("vocal-band bursts read vocal; a pure-click region does not", () => {
    const buf = blank(9);
    // 0–4 s: click train only. 5–9 s: sustained vocal-band stack.
    for (let t = 0.25; t < 4; t += 0.5) addClick(buf, t, 0.9);
    addSine(buf, 620, 0.22, 5, 9);
    addSine(buf, 930, 0.18, 5, 9);
    addSine(buf, 1420, 0.12, 5, 9);
    const read = analyseSamples(buf, SR, { depth: "deep" });
    const windows = read?.vocalActivity ?? [];
    const vocalWindow = windows.find((w) => w.startMs === 6000);
    const clickWindow = windows.find((w) => w.startMs === 1000);
    console.log(
      `[ground-truth] vocal@6s=${JSON.stringify(vocalWindow)} click@1s=${JSON.stringify(clickWindow)}`,
    );
    expect(vocalWindow?.activity).toBeGreaterThan(0.6);
    expect(clickWindow?.activity).toBeLessThan(0.3);
  });
});

describe("analyseSamples — unreadable audio", () => {
  it("silence returns null", () => {
    expect(analyseSamples(blank(3), SR, { depth: "deep" })).toBeNull();
  });

  it("near-silence returns null, and degenerate input returns null", () => {
    const tiny = blank(3);
    for (let i = 0; i < tiny.length; i += 1) tiny[i] = 1e-6;
    expect(analyseSamples(tiny, SR, { depth: "fast" })).toBeNull();
    expect(
      analyseSamples(new Float32Array(10), SR, { depth: "deep" }),
    ).toBeNull();
    expect(analyseSamples(clickTrain(4, 120), 0, { depth: "deep" })).toBeNull();
  });
});
