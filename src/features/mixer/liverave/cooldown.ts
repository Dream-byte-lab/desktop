// cooldown.ts — the Cooldown Shelf (optimisation wave item 8;
// ADAPTATION A9).
//
// Just-played artists, just-used techniques and just-played
// tracks sit out a set number of transitions, so the set breathes
// instead of repeating itself. The bookkeeping mirrors Block
// Blast's post-event counters with the intent inverted: success
// and failure cool down DIFFERENTLY — a technique the listener
// skipped out of (an Ear outcome, item 5) is benched far longer
// than one that merely played. The shelf never binds the first
// transition of a session (the engine opens with no read on the
// room), and its state is persisted per mode (personality) and
// fully inspectable: when something is benched, the reason is a
// readable string, not archaeology.
//
// The shelf is a slate EDITOR (item 3): it vetoes candidates
// whose track/technique is benched. Two liveness waivers keep it
// from ever starving a set, and both are reported, never silent:
// a bench is waived when every remaining candidate shares the
// benched artist (a one-artist queue is a fact, not a failure),
// and when a veto would empty the slate entirely.

import type { JoinFamily, ScratchTechnique } from "./recipe";

/** Transitions a technique sits out after it plays. */
export const TECHNIQUE_SUCCESS_COOLDOWN = 2;
/** Transitions a technique sits out after a skip-out failure. */
export const TECHNIQUE_FAILURE_COOLDOWN = 6;
/** Transitions an artist sits out after one of their tracks plays. */
export const ARTIST_COOLDOWN = 2;
/** Transitions a track itself sits out after it plays. */
export const TRACK_COOLDOWN = 3;

/**
 * The technique classes the shelf benches: the scratch
 * techniques and the theatre families. The core blend families
 * are the set's bread — benching them would bench the night.
 */
export const BENCHED_FAMILIES: readonly JoinFamily[] = [
  "drop-cut",
  "stop-exit",
];

export function techniqueKeyOf(input: {
  family: JoinFamily | null;
  technique?: ScratchTechnique;
}): string | null {
  if (input.technique) return input.technique;
  if (input.family && BENCHED_FAMILIES.includes(input.family)) {
    return input.family;
  }
  return null;
}

export interface ShelfMark {
  /** Transition index at which the entry last played. */
  lastUsedAt: number;
  /** Benched for transitions with index in (lastUsedAt, benchUntil]. */
  benchUntil: number;
  /** How the last use ended, when the Ear reported it. */
  lastOutcome: "success" | "failure" | null;
}

export interface ShelfState {
  mode: string;
  /** Transitions landed in this mode, across restarts. */
  transitionIndex: number;
  artists: Record<string, ShelfMark>;
  techniques: Record<string, ShelfMark>;
  tracks: Record<string, ShelfMark>;
}

export function emptyShelfState(mode: string): ShelfState {
  return { mode, transitionIndex: 0, artists: {}, techniques: {}, tracks: {} };
}

/** The persistence seam (storage.ts wires IndexedDB behind it). */
export interface ShelfStore {
  load(mode: string): ShelfState | null;
  save(state: ShelfState): void;
}

export function createInMemoryShelfStore(): ShelfStore {
  const states = new Map<string, ShelfState>();
  return {
    load: (mode) => {
      const state = states.get(mode);
      return state ? structuredClone(state) : null;
    },
    save: (state) => {
      states.set(state.mode, structuredClone(state));
    },
  };
}

export interface BenchReason {
  kind: "artist" | "technique" | "track";
  key: string;
  /** Readable, e.g. for narration and the inspect surface. */
  reason: string;
}

export class CooldownShelf {
  private state: ShelfState;
  private readonly store: ShelfStore;

  constructor(store: ShelfStore, mode: string) {
    this.store = store;
    this.state = store.load(mode) ?? emptyShelfState(mode);
  }

  get mode(): string {
    return this.state.mode;
  }

  /** Transitions landed so far in this mode. */
  get transitionIndex(): number {
    return this.state.transitionIndex;
  }

  /** The index the NEXT transition will land at. */
  upcomingIndex(): number {
    return this.state.transitionIndex + 1;
  }

  /** Switch mode (personality): state is per-mode, persisted. */
  setMode(mode: string): void {
    if (mode === this.state.mode) return;
    this.store.save(this.state);
    this.state = this.store.load(mode) ?? emptyShelfState(mode);
  }

  /**
   * A transition landed: advance the index and stamp the marks.
   * The used technique earns its success cooldown here; a later
   * Ear failure outcome extends it (noteJoinFailure).
   */
  noteTransition(input: {
    artist: string | null;
    techniqueKey: string | null;
    trackId: string;
  }): void {
    this.state.transitionIndex += 1;
    const index = this.state.transitionIndex;
    if (input.artist) {
      this.state.artists[input.artist] = {
        lastUsedAt: index,
        benchUntil: index + ARTIST_COOLDOWN,
        lastOutcome: this.state.artists[input.artist]?.lastOutcome ?? null,
      };
    }
    if (input.techniqueKey) {
      this.state.techniques[input.techniqueKey] = {
        lastUsedAt: index,
        benchUntil: index + TECHNIQUE_SUCCESS_COOLDOWN,
        lastOutcome:
          this.state.techniques[input.techniqueKey]?.lastOutcome ?? null,
      };
    }
    this.state.tracks[input.trackId] = {
      lastUsedAt: index,
      benchUntil: index + TRACK_COOLDOWN,
      lastOutcome: this.state.tracks[input.trackId]?.lastOutcome ?? null,
    };
    this.store.save(this.state);
  }

  /** The Ear's verdict: this technique's join was skipped out of. */
  noteJoinFailure(techniqueKey: string | null): void {
    if (!techniqueKey) return;
    const mark = this.state.techniques[techniqueKey];
    if (!mark) return;
    mark.lastOutcome = "failure";
    mark.benchUntil = Math.max(
      mark.benchUntil,
      this.state.transitionIndex + TECHNIQUE_FAILURE_COOLDOWN,
    );
    this.store.save(this.state);
  }

  /** The Ear's verdict: this technique's join landed. */
  noteJoinSuccess(techniqueKey: string | null): void {
    if (!techniqueKey) return;
    const mark = this.state.techniques[techniqueKey];
    if (!mark) return;
    mark.lastOutcome = "success";
    this.store.save(this.state);
  }

  /**
   * Is a candidate with this artist/technique/track benched for
   * the upcoming transition? Never on the session's first
   * transition. Returns the strongest reason, or null.
   */
  benchFor(input: {
    artist: string | null;
    techniqueKey: string | null;
    trackId: string;
  }): BenchReason | null {
    if (this.state.transitionIndex === 0) return null;
    const upcoming = this.upcomingIndex();
    const check = (
      kind: BenchReason["kind"],
      map: Record<string, ShelfMark>,
      key: string | null,
    ): BenchReason | null => {
      if (!key) return null;
      const mark = map[key];
      if (!mark) return null;
      if (upcoming > mark.lastUsedAt && upcoming <= mark.benchUntil) {
        const ago = upcoming - mark.lastUsedAt;
        const span = mark.benchUntil - mark.lastUsedAt;
        return {
          kind,
          key,
          reason:
            `${kind} "${key}" is on the cooldown shelf — played ${ago} transition${ago === 1 ? "" : "s"} ago` +
            `${mark.lastOutcome === "failure" ? " and was skipped out of" : ""} (sits out ${span})`,
        };
      }
      return null;
    };
    return (
      check("technique", this.state.techniques, input.techniqueKey) ??
      check("artist", this.state.artists, input.artist) ??
      check("track", this.state.tracks, input.trackId)
    );
  }

  /** The whole shelf, readable — the inspect surface. */
  inspect(): { mode: string; transitionIndex: number; lines: string[] } {
    const lines: string[] = [];
    const upcoming = this.upcomingIndex();
    const dump = (kind: string, map: Record<string, ShelfMark>): void => {
      for (const [key, mark] of Object.entries(map)) {
        const benched =
          this.state.transitionIndex > 0 &&
          upcoming > mark.lastUsedAt &&
          upcoming <= mark.benchUntil;
        lines.push(
          `${kind} "${key}": last played at transition ${mark.lastUsedAt}, ` +
            `sits out until ${mark.benchUntil}${benched ? " — BENCHED NOW" : ""}` +
            `${mark.lastOutcome ? `, last outcome ${mark.lastOutcome}` : ""}`,
        );
      }
    };
    dump("artist", this.state.artists);
    dump("technique", this.state.techniques);
    dump("track", this.state.tracks);
    return {
      mode: this.state.mode,
      transitionIndex: this.state.transitionIndex,
      lines,
    };
  }

  snapshot(): ShelfState {
    return structuredClone(this.state);
  }
}
