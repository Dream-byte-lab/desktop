import { describe, expect, it } from "vitest";
import { detectKey } from "./detectKey";

const SAMPLE_RATE = 44100;

function midi(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** A sustained chord: the given MIDI notes as plain sine tones. */
function chord(midis: number[], seconds: number): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    let v = 0;
    for (const m of midis) {
      v += Math.sin(2 * Math.PI * midi(m) * t);
    }
    out[i] = v / midis.length;
  }
  return out;
}

describe("detectKey", () => {
  it("hears C major and names its Camelot label", () => {
    // C3 root + C major triad (C4 E4 G4)
    const key = detectKey(chord([48, 60, 64, 67], 4), SAMPLE_RATE);
    expect(key).not.toBeNull();
    expect(key!.tonic).toBe("C");
    expect(key!.mode).toBe("major");
    expect(key!.camelot).toBe("8B");
    expect(key!.confidence).toBeGreaterThan(0.5);
  });

  it("hears A minor, the relative minor of C major", () => {
    // A2/A3 root + A minor triad (A3 C4 E4) — same notes family as
    // C major, different centre: the profile test must tell them apart
    const key = detectKey(chord([45, 57, 60, 64], 4), SAMPLE_RATE);
    expect(key).not.toBeNull();
    expect(key!.tonic).toBe("A");
    expect(key!.mode).toBe("minor");
    expect(key!.camelot).toBe("8A");
  });

  it("hears G major", () => {
    // G3 root + G major triad (G3 B3 D4)
    const key = detectKey(chord([55, 59, 62], 4), SAMPLE_RATE);
    expect(key).not.toBeNull();
    expect(key!.tonic).toBe("G");
    expect(key!.mode).toBe("major");
    expect(key!.camelot).toBe("9B");
  });

  it("returns null for silence", () => {
    expect(detectKey(new Float32Array(SAMPLE_RATE * 4), SAMPLE_RATE)).toBe(
      null,
    );
  });
});
