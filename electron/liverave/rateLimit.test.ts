import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "./rateLimit";

const WINDOW = 15 * 60_000;

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit, then blocks with a retry delay", () => {
    const limiter = new SlidingWindowLimiter(3, WINDOW);
    expect(limiter.hit("guest", 0).allowed).toBe(true);
    expect(limiter.hit("guest", 1000).allowed).toBe(true);
    expect(limiter.hit("guest", 2000).allowed).toBe(true);
    const blocked = limiter.hit("guest", 3000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(WINDOW - 3000);
  });

  it("lets a guest in again once the oldest hit leaves the window", () => {
    const limiter = new SlidingWindowLimiter(2, WINDOW);
    limiter.hit("guest", 0);
    limiter.hit("guest", 1000);
    expect(limiter.hit("guest", 2000).allowed).toBe(false);
    expect(limiter.hit("guest", WINDOW + 1).allowed).toBe(true);
  });

  it("keeps guests independent", () => {
    const limiter = new SlidingWindowLimiter(1, WINDOW);
    expect(limiter.hit("a", 0).allowed).toBe(true);
    expect(limiter.hit("a", 1).allowed).toBe(false);
    expect(limiter.hit("b", 1).allowed).toBe(true);
    expect(limiter.count("a", 2)).toBe(1);
    limiter.reset("a");
    expect(limiter.hit("a", 3).allowed).toBe(true);
  });
});
