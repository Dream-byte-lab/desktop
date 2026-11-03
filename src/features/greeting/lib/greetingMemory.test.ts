import { describe, expect, it } from "vitest";
import { composeFreshGreeting } from "./compose";
import {
  GREETING_MEMORY_KEY,
  MAX_REMEMBERED,
  deriveSessionContext,
  loadGreetingMemory,
  recordShowing,
  saveGreetingMemory,
  type GreetingMemoryState,
  type GreetingStorage,
} from "./greetingMemory";

function fakeStorage(): GreetingStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

const EMPTY: GreetingMemoryState = {
  shownHashes: [],
  lastShownAtMs: null,
  lastDayKey: null,
  opensOnLastDay: 0,
  streakDays: 0,
};

function day(dayOfMonth: number, hour = 9): Date {
  return new Date(2026, 10, dayOfMonth, hour, 0, 0);
}

describe("greeting memory storage", () => {
  it("round-trips through storage and survives corrupt data", () => {
    const storage = fakeStorage();
    const state = recordShowing(EMPTY, "abc123", day(2));
    saveGreetingMemory(state, storage);
    expect(storage.map.has(GREETING_MEMORY_KEY)).toBe(true);
    expect(loadGreetingMemory(storage)).toEqual(state);
    storage.map.set(GREETING_MEMORY_KEY, "{not json");
    expect(loadGreetingMemory(storage)).toEqual(EMPTY);
  });

  it("remembers hashes, dedupes, and evicts the oldest past the cap", () => {
    let state = EMPTY;
    for (let i = 0; i < MAX_REMEMBERED + 5; i++) {
      state = recordShowing(state, `hash-${i}`, day(2));
    }
    expect(state.shownHashes).toHaveLength(MAX_REMEMBERED);
    expect(state.shownHashes).not.toContain("hash-0");
    expect(state.shownHashes).toContain(`hash-${MAX_REMEMBERED + 4}`);
    const again = recordShowing(state, `hash-${MAX_REMEMBERED + 4}`, day(2));
    expect(again.shownHashes).toEqual(state.shownHashes);
  });
});

describe("deriveSessionContext", () => {
  it("first ever: no streak, no gap", () => {
    const context = deriveSessionContext(EMPTY, day(2));
    expect(context.isFirstEver).toBe(true);
    expect(context.isFirstOpenToday).toBe(true);
    expect(context.opensToday).toBe(1);
    expect(context.hoursSinceLastSession).toBeNull();
  });

  it("second open the same day continues the count and the streak", () => {
    const morning = recordShowing(EMPTY, "h1", day(2, 8));
    const context = deriveSessionContext(morning, day(2, 20));
    expect(context.isFirstOpenToday).toBe(false);
    expect(context.opensToday).toBe(2);
    expect(context.streakDays).toBe(1);
    expect(context.hoursSinceLastSession).toBeCloseTo(12, 0);
  });

  it("consecutive days build the streak; a skipped day resets it", () => {
    let state = recordShowing(EMPTY, "h1", day(2));
    state = recordShowing(state, "h2", day(3));
    const day3 = deriveSessionContext(state, day(4));
    expect(day3.isFirstOpenToday).toBe(true);
    expect(day3.streakDays).toBe(3);
    const afterGap = deriveSessionContext(state, day(6));
    expect(afterGap.streakDays).toBe(1);
  });
});

describe("the full loop through storage", () => {
  it("ninety openings over a month never repeat a greeting", () => {
    const storage = fakeStorage();
    const seen = new Set<string>();
    let counter = 0;
    for (let d = 2; d <= 31; d++) {
      for (const hour of [8, 13, 21]) {
        const now = day(d, hour);
        const memory = loadGreetingMemory(storage);
        const context = deriveSessionContext(memory, now);
        counter++;
        let n = counter * 7919;
        const rng = () => {
          n = (n * 48271) % 2147483647;
          return n / 2147483647;
        };
        const fresh = composeFreshGreeting(
          { date: now, name: "Achieng", context, rng },
          memory,
        );
        expect(seen.has(fresh.hash)).toBe(false);
        seen.add(fresh.hash);
        saveGreetingMemory(recordShowing(memory, fresh.hash, now), storage);
      }
    }
    expect(seen.size).toBe(90);
  });
});
