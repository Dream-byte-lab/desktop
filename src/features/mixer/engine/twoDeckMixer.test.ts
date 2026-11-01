import { describe, expect, it } from "vitest";
import { crossfadeGains } from "./twoDeckMixer";

describe("crossfadeGains", () => {
  it("is transparent in the centre", () => {
    expect(crossfadeGains(0)).toEqual([1, 1]);
  });

  it("fades fully to each side at the extremes", () => {
    expect(crossfadeGains(-1)[0]).toBe(1);
    expect(crossfadeGains(-1)[1]).toBeCloseTo(0, 6);
    expect(crossfadeGains(1)[0]).toBeCloseTo(0, 6);
    expect(crossfadeGains(1)[1]).toBe(1);
  });

  it("fades only the opposite deck on the way", () => {
    const [a, b] = crossfadeGains(0.5);
    expect(a).toBeCloseTo(Math.cos(Math.PI / 4), 6);
    expect(b).toBe(1);
    const [c, d] = crossfadeGains(-0.5);
    expect(c).toBe(1);
    expect(d).toBeCloseTo(Math.cos(Math.PI / 4), 6);
  });

  it("clamps positions beyond the ends", () => {
    expect(crossfadeGains(5)).toEqual(crossfadeGains(1));
    expect(crossfadeGains(-5)).toEqual(crossfadeGains(-1));
  });
});
