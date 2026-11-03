import { describe, expect, it } from "vitest";
import { analyseTrack, audioFingerprint } from "./analyseTrack";
import { beatsAtTime } from "./beatMap";

const SAMPLE_RATE = 44100;

/**
 * Builds a synthetic song: a click on every beat, a louder click on every
 * accented beat, optionally quiet until a moment where it turns loud —
 * a stand-in for a breakdown followed by a drop.
 */
function syntheticSong(options: {
  bpm: number;
  seconds: number;
  firstBeatSec: number;
  accentEvery?: number;
  quietUntilSec?: number;
}): Float32Array {
  const samples = new Float32Array(Math.floor(options.seconds * SAMPLE_RATE));
  const spb = 60 / options.bpm;
  const accentEvery = options.accentEvery ?? 4;
  for (let beat = 0; ; beat += 1) {
    const t = options.firstBeatSec + beat * spb;
    if (t >= options.seconds) break;
    const quiet =
      options.quietUntilSec !== undefined && t < options.quietUntilSec;
    const accented = beat % accentEvery === 0;
    const amp = quiet ? 0.12 : accented ? 0.95 : 0.55;
    const start = Math.floor(t * SAMPLE_RATE);
    for (let n = 0; n < 512 && start + n < samples.length; n += 1) {
      samples[start + n] +=
        amp *
        Math.exp(-n / 60) *
        Math.sin((2 * Math.PI * 180 * n) / SAMPLE_RATE);
    }
  }
  return samples;
}

describe("analyseTrack", () => {
  it(
    "finds the tempo and first downbeat of a 120 bpm click song",
    { timeout: 30000 },
    () => {
      const samples = syntheticSong({
        bpm: 120,
        seconds: 40,
        firstBeatSec: 0.25,
      });
      const analysis = analyseTrack(samples, SAMPLE_RATE);
      expect(analysis).not.toBeNull();
      expect(analysis!.beatMap.bpm).toBeGreaterThan(118);
      expect(analysis!.beatMap.bpm).toBeLessThan(122);
      expect(analysis!.beatMap.firstBeatSec).toBeGreaterThan(0.17);
      expect(analysis!.beatMap.firstBeatSec).toBeLessThan(0.33);
      expect(analysis!.tempoConfidence).toBeGreaterThan(0);
    },
  );

  it("finds a different tempo", { timeout: 30000 }, () => {
    const samples = syntheticSong({
      bpm: 126,
      seconds: 30,
      firstBeatSec: 0.1,
    });
    const analysis = analyseTrack(samples, SAMPLE_RATE);
    expect(analysis).not.toBeNull();
    expect(analysis!.beatMap.bpm).toBeGreaterThan(124);
    expect(analysis!.beatMap.bpm).toBeLessThan(128);
  });

  it(
    "spots the drop where a quiet section turns loud on a phrase boundary",
    { timeout: 30000 },
    () => {
      const samples = syntheticSong({
        bpm: 120,
        seconds: 40,
        firstBeatSec: 0,
        quietUntilSec: 16,
      });
      const analysis = analyseTrack(samples, SAMPLE_RATE);
      expect(analysis).not.toBeNull();
      expect(analysis!.drops.length).toBeGreaterThan(0);
      // The drop is at the step: 16 s in, within a beat. (V1's test
      // asserted beat 32 exactly, but beat indices count from the
      // detected first downbeat, and for uniform clicks every
      // rotation ties — the downbeat is arbitrary. What is not
      // arbitrary is the drop's TIME, which v1 blurred to 17 s and
      // v2 places on the step itself.)
      expect(analysis!.drops[0].timeSec).toBeGreaterThan(15.4);
      expect(analysis!.drops[0].timeSec).toBeLessThan(16.6);
      // …and the reported beat is the grid beat at that time.
      expect(
        Math.abs(
          beatsAtTime(analysis!.beatMap, analysis!.drops[0].timeSec) -
            analysis!.drops[0].beat,
        ),
      ).toBeLessThan(0.51);
    },
  );

  it(
    "measures absolute loudness that scales with the recording level",
    { timeout: 30000 },
    () => {
      const loud = analyseTrack(
        syntheticSong({ bpm: 120, seconds: 20, firstBeatSec: 0.1 }),
        SAMPLE_RATE,
      );
      const base = syntheticSong({ bpm: 120, seconds: 20, firstBeatSec: 0.1 });
      const quietSamples = base.map((s) => s * 0.25);
      const quiet = analyseTrack(quietSamples, SAMPLE_RATE);
      expect(loud).not.toBeNull();
      expect(quiet).not.toBeNull();
      // Same song recorded a quarter as loud: a quarter of the RMS.
      expect(loud!.loudness / quiet!.loudness).toBeCloseTo(4, 1);
      expect(loud!.loudness).toBeGreaterThan(0);
    },
  );

  it("returns null for silence", { timeout: 30000 }, () => {
    const samples = new Float32Array(SAMPLE_RATE * 10);
    expect(analyseTrack(samples, SAMPLE_RATE)).toBeNull();
  });
});

/** One span of the structure fixture: clicks at a fixed level. */
interface StructureSpan {
  untilSec: number;
  amp: number;
  /** When set, the span's level fades linearly to this amplitude. */
  fadeTo?: number;
}

/**
 * A song with KNOWN structure at 120 bpm — the fixture the v2 claims
 * are tested against:
 *   0–6   intro     (clicks at 0.10)
 *   6–18  verse     (0.30)
 *   18–30 chorus    (0.75)
 *   30–36 breakdown (0.15)
 *   36–46 drop      (0.85, a ×5.7 jump off the breakdown)
 *   46–54 outro     (fade 0.60 → 0.08)
 */
function structuredSong(): Float32Array {
  const spans: StructureSpan[] = [
    { untilSec: 6, amp: 0.1 },
    { untilSec: 18, amp: 0.3 },
    { untilSec: 30, amp: 0.75 },
    { untilSec: 36, amp: 0.15 },
    { untilSec: 46, amp: 0.85 },
    { untilSec: 54, amp: 0.6, fadeTo: 0.08 },
  ];
  const seconds = 54;
  const samples = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  const ampAt = (t: number): number => {
    let spanStart = 0;
    for (const span of spans) {
      if (t < span.untilSec) {
        if (span.fadeTo === undefined) return span.amp;
        const frac = (t - spanStart) / (span.untilSec - spanStart);
        return span.amp + (span.fadeTo - span.amp) * frac;
      }
      spanStart = span.untilSec;
    }
    return 0;
  };
  for (let beat = 0; ; beat += 1) {
    const t = beat * 0.5;
    if (t >= seconds) break;
    const amp = ampAt(t);
    const start = Math.floor(t * SAMPLE_RATE);
    for (let n = 0; n < 512 && start + n < samples.length; n += 1) {
      samples[start + n] +=
        amp *
        Math.exp(-n / 60) *
        Math.sin((2 * Math.PI * 180 * n) / SAMPLE_RATE);
    }
  }
  return samples;
}

describe("analyseTrack v2 structure", () => {
  it(
    "reads the sections of a song whose structure is known",
    { timeout: 60000 },
    () => {
      const analysis = analyseTrack(structuredSong(), SAMPLE_RATE);
      expect(analysis).not.toBeNull();
      expect(analysis!.analysisVersion).toBe(2);
      expect(analysis!.depth).toBe("deep");

      const sections = analysis!.sections!;
      expect(sections.length).toBeGreaterThanOrEqual(5);
      // Sections tile the whole track, in order, without gaps.
      expect(sections[0].startSec).toBe(0);
      expect(sections[sections.length - 1].endSec).toBeCloseTo(54, 0);
      for (let k = 1; k < sections.length; k += 1) {
        expect(
          Math.abs(sections[k].startSec - sections[k - 1].endSec),
        ).toBeLessThan(0.3);
      }
      for (const section of sections) {
        expect(section.confidence).toBeGreaterThanOrEqual(0);
        expect(section.confidence).toBeLessThanOrEqual(1);
      }

      // Intro: present, and it ends where the verse starts (±1 beat).
      expect(sections[0].kind).toBe("intro");
      expect(analysis!.intro).not.toBeNull();
      expect(Math.abs(analysis!.intro!.endSec - 6)).toBeLessThan(1);
      // The verse is a verse, not more intro.
      expect(sections[1].kind).toBe("verse");
      // The first big span is the chorus (or the drop into it).
      expect(["chorus", "drop"]).toContain(sections[2].kind);
      // The breakdown is found, where it was put.
      const breakdown = sections.find((s) => s.kind === "breakdown");
      expect(breakdown).toBeDefined();
      expect(Math.abs(breakdown!.startSec - 30)).toBeLessThan(2);
      // Outro: present, starting where the fade starts (±2 s).
      expect(analysis!.outro).not.toBeNull();
      expect(Math.abs(analysis!.outro!.startSec - 46)).toBeLessThan(2.5);
      expect(sections[sections.length - 1].kind).toBe("outro");
    },
  );

  it(
    "places a graded drop event on the breakdown-to-drop jump",
    { timeout: 60000 },
    () => {
      const analysis = analyseTrack(structuredSong(), SAMPLE_RATE);
      expect(analysis).not.toBeNull();
      const at36 = analysis!.drops.find((d) => Math.abs(d.timeSec - 36) < 1);
      expect(at36).toBeDefined();
      expect(at36!.strength).toBeGreaterThan(3);
    },
  );

  it(
    "finds drop events between loud passages too, with graded strength",
    { timeout: 60000 },
    () => {
      // No quiet anywhere: 0.5 clicks, surging to 0.9 at 20 s. V1's
      // rule (before must be < 0.5 normalised) could never fire here;
      // v2 reports the surge as a drop of modest strength.
      const samples = new Float32Array(Math.floor(44 * SAMPLE_RATE));
      for (let beat = 0; ; beat += 1) {
        const t = beat * 0.5;
        if (t >= 44) break;
        const amp = t < 20 ? 0.5 : 0.9;
        const start = Math.floor(t * SAMPLE_RATE);
        for (let n = 0; n < 512 && start + n < samples.length; n += 1) {
          samples[start + n] +=
            amp *
            Math.exp(-n / 60) *
            Math.sin((2 * Math.PI * 180 * n) / SAMPLE_RATE);
        }
      }
      const analysis = analyseTrack(samples, SAMPLE_RATE);
      expect(analysis).not.toBeNull();
      expect(analysis!.drops.length).toBeGreaterThan(0);
      expect(Math.abs(analysis!.drops[0].timeSec - 20)).toBeLessThan(1);
      expect(analysis!.drops[0].strength).toBeGreaterThan(1.4);
      expect(analysis!.drops[0].strength).toBeLessThan(3.5);
    },
  );

  it(
    "exposes an absolute sub-second energy contour",
    { timeout: 60000 },
    () => {
      const analysis = analyseTrack(structuredSong(), SAMPLE_RATE);
      const contour = analysis!.energyContour!;
      expect(contour.length).toBeGreaterThan(200);
      expect(contour.length).toBeLessThan(224);
      const meanIn = (from: number, to: number): number => {
        const pts = contour.filter((p) => p.timeSec >= from && p.timeSec < to);
        return pts.reduce((a, p) => a + p.rms, 0) / Math.max(1, pts.length);
      };
      // Absolute: the drop span really is ~8× the intro's level.
      expect(meanIn(38, 44) / meanIn(1, 5)).toBeGreaterThan(4);
    },
  );

  it("fingerprints the audio it analysed", { timeout: 60000 }, () => {
    const samples = structuredSong();
    const a = analyseTrack(samples, SAMPLE_RATE);
    expect(a!.audioHash).toBe(audioFingerprint(samples, SAMPLE_RATE));
    expect(audioFingerprint(samples, SAMPLE_RATE)).toBe(
      audioFingerprint(samples, SAMPLE_RATE),
    );
    const scaled = samples.map((s) => s * 0.5);
    expect(audioFingerprint(scaled, SAMPLE_RATE)).not.toBe(a!.audioHash);
  });

  it(
    "fast depth reads the same structure at coarser vocal resolution",
    { timeout: 60000 },
    () => {
      const samples = structuredSong();
      const fast = analyseTrack(samples, SAMPLE_RATE, { depth: "fast" });
      const deep = analyseTrack(samples, SAMPLE_RATE, { depth: "deep" });
      expect(fast!.depth).toBe("fast");
      expect(fast!.vocalActivity!.stepSec).toBe(0.5);
      expect(deep!.vocalActivity!.stepSec).toBe(0.25);
      expect(fast!.sections!.length).toBe(deep!.sections!.length);
      expect(fast!.keyWindows!.body).toBeNull();
      expect(fast!.keyWindows!.closing).toBeNull();
    },
  );

  it(
    "reads the key over several windows on a long tonal track",
    { timeout: 60000 },
    () => {
      // 80 s: a C-major triad bed under 120 bpm clicks.
      const seconds = 80;
      const samples = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
      const triad = [130.81, 164.81, 196.0];
      for (let i = 0; i < samples.length; i += 1) {
        for (const f of triad) {
          samples[i] += 0.05 * Math.sin((2 * Math.PI * f * i) / SAMPLE_RATE);
        }
      }
      for (let beat = 0; ; beat += 1) {
        const t = beat * 0.5;
        if (t >= seconds) break;
        const start = Math.floor(t * SAMPLE_RATE);
        for (let n = 0; n < 512 && start + n < samples.length; n += 1) {
          samples[start + n] +=
            0.3 *
            Math.exp(-n / 60) *
            Math.sin((2 * Math.PI * 180 * n) / SAMPLE_RATE);
        }
      }
      const deep = analyseTrack(samples, SAMPLE_RATE);
      expect(deep).not.toBeNull();
      expect(deep!.key).not.toBeNull();
      expect(deep!.key!.pitchClass).toBe(0); // C
      expect(deep!.key!.tonic).toBe("C");
      expect(deep!.key!.mode).toBe("major");
      // 80 s ≥ 70: the closing window was read too.
      expect(deep!.keyWindows!.closing).not.toBeNull();
    },
  );
});

/**
 * A click track whose tempo DRIFTS linearly from 120 to 128 bpm over
 * 60 s. Beat times are integrated, so the test knows exactly where
 * every true beat falls.
 */
function driftSong(): { samples: Float32Array; beatTimes: number[] } {
  const seconds = 60;
  const samples = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  const beatTimes: number[] = [];
  let t = 0;
  while (t < seconds) {
    beatTimes.push(t);
    const bpm = 120 + (8 * t) / seconds;
    t += 60 / bpm;
  }
  for (const bt of beatTimes) {
    const start = Math.floor(bt * SAMPLE_RATE);
    for (let n = 0; n < 512 && start + n < samples.length; n += 1) {
      samples[start + n] +=
        0.4 *
        Math.exp(-n / 60) *
        Math.sin((2 * Math.PI * 180 * n) / SAMPLE_RATE);
    }
  }
  return { samples, beatTimes };
}

describe("analyseTrack v2 beat grid", () => {
  it(
    "follows a drifting tempo instead of asserting one rigid grid",
    { timeout: 60000 },
    () => {
      const { samples, beatTimes } = driftSong();
      const analysis = analyseTrack(samples, SAMPLE_RATE);
      expect(analysis).not.toBeNull();
      const grid = analysis!.beatMap.grid!;
      expect(grid).toBeDefined();
      expect(grid.confidence).toBeGreaterThan(0.3);
      expect(grid.anchors.length).toBeGreaterThan(60);

      // Mid-track: an anchor sits on a true beat (within 0.12 s),
      // and the grid's own beat↔time mapping — the thing a decider
      // actually reads — is true there too, even though the single
      // summary tempo (an average) cannot be right at both ends of
      // a drifting track at once.
      const midIdx = beatTimes.reduce(
        (best, bt, i) =>
          Math.abs(bt - 30) < Math.abs(beatTimes[best] - 30) ? i : best,
        0,
      );
      const midTrue = beatTimes[midIdx];
      const nearestAnchor = Math.min(
        ...grid.anchors.map((a) => Math.abs(a.timeSec - midTrue)),
      );
      expect(nearestAnchor).toBeLessThan(0.12);
      expect(
        Math.abs(beatsAtTime(analysis!.beatMap, midTrue) - midIdx),
      ).toBeLessThan(0.5);

      // The grid's own sections admit the tempo rose.
      const first = grid.sections[0];
      const last = grid.sections[grid.sections.length - 1];
      expect(last.bpm).toBeGreaterThan(first.bpm + 2);
    },
  );
});
