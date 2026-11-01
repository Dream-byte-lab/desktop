// A sliding-window rate limiter, one bucket per key. liveRave uses
// it at the party door: each guest phone may make only so many NEW
// requests in a window (duplicates are votes and never reach this —
// the server checks them first). Deliberately tiny and pure, so the
// fairness rule is testable in isolation.

export interface LimitResult {
  allowed: boolean;
  /** When blocked, how long until the oldest hit leaves the window. */
  retryAfterMs: number;
}

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records an attempt for `key` at `nowMs` and reports the verdict. */
  hit(key: string, nowMs: number): LimitResult {
    const fresh = (this.hits.get(key) ?? []).filter(
      (at) => nowMs - at < this.windowMs,
    );
    if (fresh.length >= this.limit) {
      this.hits.set(key, fresh);
      return {
        allowed: false,
        retryAfterMs: fresh[0] + this.windowMs - nowMs,
      };
    }
    fresh.push(nowMs);
    this.hits.set(key, fresh);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** How many hits `key` currently has inside the window. */
  count(key: string, nowMs: number): number {
    return (this.hits.get(key) ?? []).filter((at) => nowMs - at < this.windowMs)
      .length;
  }

  /** Forgets one key, or every key when none is given. */
  reset(key?: string): void {
    if (key === undefined) this.hits.clear();
    else this.hits.delete(key);
  }
}
