// The greeting's memory — what makes "never the same twice" a
// guarantee instead of a hope. Every greeting shown is hashed and
// remembered (bounded, in localStorage); the composer redraws any
// repeat. The same record carries the session facts the composer
// reads as live context: whether this is today's first open, the
// consecutive-day streak, and how long since the last session.
// Storage is injectable for tests; the app uses localStorage with
// an in-memory fallback, mirroring the taste tracker's approach.

export const GREETING_MEMORY_KEY = "liner_greeting_memory_v1";

/** How many shown greetings are remembered for the no-repeat check. */
export const MAX_REMEMBERED = 500;

export interface GreetingMemoryState {
  /** Hashes of greetings already shown, oldest first. */
  shownHashes: string[];
  /** When the last greeting was shown (ms epoch), or null if never. */
  lastShownAtMs: number | null;
  /** Local day key ("2026-11-02") of the last showing, or null. */
  lastDayKey: string | null;
  /** How many greetings have been shown on lastDayKey. */
  opensOnLastDay: number;
  /** Consecutive days with at least one showing, ending on lastDayKey. */
  streakDays: number;
}

/** Live context the composer assembles from, derived per opening. */
export interface SessionContext {
  /** True when no greeting has ever been shown on this device. */
  isFirstEver: boolean;
  /** True when this is the first greeting of today. */
  isFirstOpenToday: boolean;
  /** Greetings shown today including this one. */
  opensToday: number;
  /** Consecutive-day streak including today (0 when not applicable). */
  streakDays: number;
  /** Hours since the previous session's greeting, or null if none. */
  hoursSinceLastSession: number | null;
}

export interface GreetingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const EMPTY: GreetingMemoryState = {
  shownHashes: [],
  lastShownAtMs: null,
  lastDayKey: null,
  opensOnLastDay: 0,
  streakDays: 0,
};

export function dayKeyOf(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayKeyBefore(date: Date, days: number): string {
  const before = new Date(date);
  before.setDate(before.getDate() - days);
  return dayKeyOf(before);
}

let fallbackState: GreetingMemoryState | null = null;

function defaultStorage(): GreetingStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Private modes and odd embeddings: fall through to memory-only.
  }
  return null;
}

export function loadGreetingMemory(
  storage: GreetingStorage | null = defaultStorage(),
): GreetingMemoryState {
  if (!storage) return fallbackState ?? { ...EMPTY };
  try {
    const raw = storage.getItem(GREETING_MEMORY_KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<GreetingMemoryState>;
    return {
      shownHashes: Array.isArray(parsed.shownHashes)
        ? parsed.shownHashes.filter((h) => typeof h === "string")
        : [],
      lastShownAtMs:
        typeof parsed.lastShownAtMs === "number" ? parsed.lastShownAtMs : null,
      lastDayKey:
        typeof parsed.lastDayKey === "string" ? parsed.lastDayKey : null,
      opensOnLastDay:
        typeof parsed.opensOnLastDay === "number" ? parsed.opensOnLastDay : 0,
      streakDays: typeof parsed.streakDays === "number" ? parsed.streakDays : 0,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function saveGreetingMemory(
  state: GreetingMemoryState,
  storage: GreetingStorage | null = defaultStorage(),
): void {
  if (!storage) {
    fallbackState = state;
    return;
  }
  try {
    storage.setItem(GREETING_MEMORY_KEY, JSON.stringify(state));
  } catch {
    fallbackState = state;
  }
}

/** The live context for an opening at `now`, from the stored state. */
export function deriveSessionContext(
  state: GreetingMemoryState,
  now: Date,
): SessionContext {
  const today = dayKeyOf(now);
  const isFirstEver = state.lastShownAtMs === null;
  const isFirstOpenToday = state.lastDayKey !== today;
  const opensToday = isFirstOpenToday ? 1 : state.opensOnLastDay + 1;
  let streakDays = 0;
  if (!isFirstEver) {
    if (!isFirstOpenToday) streakDays = state.streakDays;
    else if (state.lastDayKey === dayKeyBefore(now, 1))
      streakDays = state.streakDays + 1;
    else streakDays = 1;
  }
  const hoursSinceLastSession =
    state.lastShownAtMs === null
      ? null
      : Math.max(0, (now.getTime() - state.lastShownAtMs) / 3_600_000);
  return {
    isFirstEver,
    isFirstOpenToday,
    opensToday,
    streakDays,
    hoursSinceLastSession,
  };
}

/**
 * Records that a greeting (by hash) was shown at `now`, returning the
 * next state. The hash joins the no-repeat memory (bounded, oldest
 * evicted first) and the day/streak bookkeeping advances.
 */
export function recordShowing(
  state: GreetingMemoryState,
  hash: string,
  now: Date,
): GreetingMemoryState {
  const context = deriveSessionContext(state, now);
  const shownHashes = state.shownHashes.includes(hash)
    ? state.shownHashes
    : [...state.shownHashes, hash].slice(-MAX_REMEMBERED);
  return {
    shownHashes,
    lastShownAtMs: now.getTime(),
    lastDayKey: dayKeyOf(now),
    opensOnLastDay: context.opensToday,
    streakDays: Math.max(1, context.streakDays),
  };
}
