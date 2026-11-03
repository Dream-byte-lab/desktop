import { describe, expect, it } from "vitest";
import { stretchChannelsOffThread } from "./stretchTrackRunner";

// The stretch runner, in an environment with no Worker global: the
// analysis runner's discipline says the caller never knows the
// difference — the render runs inline and the result is identical.
// These tests pin that contract (shape, exact length, failure as
// null) on the inline path the test environment exercises.

const SAMPLE_RATE = 44100;

function tone(seconds: number, freq = 220): Float32Array {
  const out = new Float32Array(Math.floor(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i += 1) {
    out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  }
  return out;
}

describe("stretchChannelsOffThread (inline fallback path)", () => {
  it("renders stereo channels to exactly round(length / factor) frames", async () => {
    const left = tone(2);
    const right = tone(2, 330);
    const rendered = await stretchChannelsOffThread(
      [left, right],
      SAMPLE_RATE,
      1.1,
    );
    expect(rendered).not.toBeNull();
    expect(rendered).toHaveLength(2);
    expect(rendered![0].length).toBe(Math.round(left.length / 1.1));
    expect(rendered![1].length).toBe(Math.round(left.length / 1.1));
    // The caller's arrays survive untouched (the fallback contract).
    expect(left.length).toBe(2 * SAMPLE_RATE);
  });

  it("slowing down lengthens by the same exact rule", async () => {
    const mono = tone(1.5);
    const rendered = await stretchChannelsOffThread([mono], SAMPLE_RATE, 0.94);
    expect(rendered).not.toBeNull();
    expect(rendered).toHaveLength(1);
    expect(rendered![0].length).toBe(Math.round(mono.length / 0.94));
  });

  it("answers null, never a throw, when the render cannot run", async () => {
    const rendered = await stretchChannelsOffThread([], SAMPLE_RATE, 1.1);
    expect(rendered).toBeNull();
  });
});
