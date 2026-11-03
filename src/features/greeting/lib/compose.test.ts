import { describe, expect, it } from "vitest";
import {
  composeFreshGreeting,
  composeGreeting,
  contextLinesFor,
  greetingHash,
  type SessionContext,
} from "./compose";
import type { GreetingMemoryState } from "./greetingMemory";

/** Deterministic rng for tests (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An rng that plays back scripted draws, then falls back to seeded. */
function scripted(draws: number[], fallbackSeed = 42): () => number {
  const queue = [...draws];
  const fallback = seeded(fallbackSeed);
  return () => (queue.length > 0 ? queue.shift()! : fallback());
}

const PLAIN: SessionContext = {
  isFirstEver: false,
  isFirstOpenToday: true,
  opensToday: 1,
  streakDays: 1,
  hoursSinceLastSession: 2,
};

function at(day: number, hour: number): Date {
  return new Date(2026, 10, day, hour, 15, 0);
}

function emptyMemory(): GreetingMemoryState {
  return {
    shownHashes: [],
    lastShownAtMs: null,
    lastDayKey: null,
    opensOnLastDay: 0,
    streakDays: 0,
  };
}

describe("composeGreeting", () => {
  it("hundreds of openings in the SAME context are all distinct", () => {
    const memory = emptyMemory();
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const fresh = composeFreshGreeting(
        {
          date: at(2, 19),
          name: "Achieng",
          context: PLAIN,
          rng: seeded(i + 1),
        },
        memory,
      );
      expect(seen.has(fresh.hash)).toBe(false);
      seen.add(fresh.hash);
      memory.shownHashes.push(fresh.hash);
    }
    expect(seen.size).toBe(300);
  });

  it("hundreds of openings across days and hours are all distinct", () => {
    const memory = emptyMemory();
    const seen = new Set<string>();
    let seed = 1000;
    for (let day = 2; day <= 16; day++) {
      for (const hour of [7, 12, 19, 23]) {
        for (let k = 0; k < 7; k++) {
          const fresh = composeFreshGreeting(
            {
              date: at(day, hour),
              name: "Achieng",
              context: PLAIN,
              rng: seeded(seed++),
            },
            memory,
          );
          expect(seen.has(fresh.hash)).toBe(false);
          seen.add(fresh.hash);
          memory.shownHashes.push(fresh.hash);
        }
      }
    }
    expect(seen.size).toBe(15 * 4 * 7);
  });

  it("a forced collision is redrawn, never returned", () => {
    const draws = [0.1, 0, 0, 0, 0];
    const first = composeGreeting({
      date: at(2, 8),
      name: "Achieng",
      context: PLAIN,
      rng: scripted(draws),
    });
    const memory = emptyMemory();
    memory.shownHashes.push(greetingHash(first));
    const fresh = composeFreshGreeting(
      {
        date: at(2, 8),
        name: "Achieng",
        context: PLAIN,
        rng: scripted(draws, 7),
      },
      memory,
    );
    expect(fresh.hash).not.toBe(greetingHash(first));
    expect(memory.shownHashes).not.toContain(fresh.hash);
  });

  it("keeps band material in its band: Happy lunch only at midday", () => {
    for (const hour of [5, 8, 14, 17, 22, 2]) {
      for (let i = 0; i < 200; i++) {
        const g = composeGreeting({
          date: at(2, hour),
          context: PLAIN,
          rng: seeded(hour * 1000 + i),
        });
        expect(g.headline).not.toContain("Happy lunch");
      }
    }
    let sawHappyLunch = false;
    for (let i = 0; i < 300 && !sawHappyLunch; i++) {
      const g = composeGreeting({
        date: at(2, 12),
        context: PLAIN,
        rng: seeded(50_000 + i),
      });
      if (g.headline.includes("Happy lunch")) sawHappyLunch = true;
    }
    expect(sawHappyLunch).toBe(true);
  });

  it("morning material stays out of the evening", () => {
    for (let i = 0; i < 200; i++) {
      const g = composeGreeting({
        date: at(2, 20),
        context: PLAIN,
        rng: seeded(90_000 + i),
      });
      expect(g.headline).not.toContain("Good morning");
      expect(g.headline).not.toContain("Rise and shine");
    }
  });

  it("weaves the name in when known — in every structure", () => {
    const streaky: SessionContext = { ...PLAIN, streakDays: 5 };
    for (let i = 0; i < 300; i++) {
      const g = composeGreeting({
        date: at(2, 9),
        name: "Achieng",
        context: streaky,
        rng: seeded(120_000 + i),
      });
      expect(g.headline).toContain("Achieng");
    }
  });

  it("guests get well-formed greetings with no name woven", () => {
    for (let i = 0; i < 200; i++) {
      const g = composeGreeting({
        date: at(2, 21),
        context: PLAIN,
        rng: seeded(150_000 + i),
      });
      expect(g.headline.length).toBeGreaterThan(0);
      expect(g.subline.length).toBeGreaterThan(0);
      expect(g.headline).not.toContain("undefined");
      expect(g.subline).not.toContain("undefined");
    }
  });
});

describe("contextLinesFor", () => {
  it("a streak becomes an observation only from day three", () => {
    const day2 = contextLinesFor({ ...PLAIN, streakDays: 2 }, at(2, 9));
    expect(day2.observations.join(" ")).not.toContain("in a row");
    const day3 = contextLinesFor({ ...PLAIN, streakDays: 3 }, at(2, 9));
    expect(day3.observations).toContain("3 days in a row");
  });

  it("returning after a long gap is observed; a same-day return is 'again'", () => {
    const returned = contextLinesFor(
      { ...PLAIN, hoursSinceLastSession: 24 * 9 },
      at(2, 9),
    );
    expect(returned.observations.length).toBeGreaterThan(0);
    const again = contextLinesFor(
      { ...PLAIN, isFirstOpenToday: false, opensToday: 3 },
      at(2, 21),
    );
    expect(again.observations).toContain("Back for more");
  });

  it("weekday and season lines join the middles", () => {
    // 2026-11-06 is a Friday, in autumn.
    const friday = contextLinesFor(PLAIN, new Date(2026, 10, 6, 9, 0));
    expect(friday.extraMiddles.join(" ")).toContain("Friday");
    expect(friday.extraMiddles.join(" ")).toContain("Autumn");
    const january = contextLinesFor(PLAIN, new Date(2026, 0, 15, 9, 0));
    expect(january.extraMiddles.join(" ")).toContain("Cold outside");
  });

  it("context actually changes the composed greeting", () => {
    const forceObserved = [0.75, 0, 0, 0, 0, 0];
    const streaky = composeGreeting({
      date: at(2, 9),
      name: "Achieng",
      context: { ...PLAIN, streakDays: 4 },
      rng: scripted(forceObserved),
    });
    expect(streaky.headline).toContain("4 days in a row");
    const plain = composeGreeting({
      date: at(2, 9),
      name: "Achieng",
      context: PLAIN,
      rng: scripted(forceObserved),
    });
    expect(plain.headline).not.toContain("in a row");
  });
});
