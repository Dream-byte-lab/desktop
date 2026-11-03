import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearUserCues, loadUserCues, saveUserCue } from "./userCues";

const KEY = "linerave_stage_cues_v1";

// In-memory localStorage fake, following the pattern used by
// src/features/lyrics/lyricsCache.test.ts: a Map-backed mock assigned
// to globalThis (and window) via Object.defineProperty.
const store = new Map<string, string>();
const localStorageMock = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => store.clear(),
  key: (index: number) => Array.from(store.keys())[index] ?? null,
  get length() {
    return store.size;
  },
};

function installStorage(value: unknown) {
  Object.defineProperty(globalThis, "localStorage", {
    value,
    writable: true,
    configurable: true,
  });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, "localStorage", {
      value,
      writable: true,
      configurable: true,
    });
  }
}

beforeAll(() => {
  installStorage(localStorageMock);
});

beforeEach(() => {
  installStorage(localStorageMock);
  localStorageMock.clear();
});

describe("loadUserCues", () => {
  it("returns an empty list for an unknown track", () => {
    expect(loadUserCues("track-1")).toEqual([]);
  });

  it("returns stored cues sorted by time", () => {
    store.set(
      KEY,
      JSON.stringify({
        "track-1": [
          { timeSec: 30, label: "Later" },
          { timeSec: 5, label: "Early" },
        ],
      }),
    );
    expect(loadUserCues("track-1")).toEqual([
      { timeSec: 5, label: "Early" },
      { timeSec: 30, label: "Later" },
    ]);
  });

  it("filters out malformed stored entries", () => {
    store.set(
      KEY,
      JSON.stringify({
        "track-1": [
          { timeSec: 10, label: "Good" },
          { timeSec: "nope", label: "Bad time" },
          { label: "No time" },
          null,
          { timeSec: 20 },
        ],
      }),
    );
    expect(loadUserCues("track-1")).toEqual([{ timeSec: 10, label: "Good" }]);
  });

  it("returns an empty list when the stored value is corrupt JSON", () => {
    store.set(KEY, "{not json at all");
    expect(loadUserCues("track-1")).toEqual([]);
  });

  it("returns an empty list when the stored value has the wrong shape", () => {
    store.set(KEY, JSON.stringify(["not", "a", "record"]));
    expect(loadUserCues("track-1")).toEqual([]);
    store.set(KEY, JSON.stringify({ "track-1": "not-a-list" }));
    expect(loadUserCues("track-1")).toEqual([]);
  });
});

describe("saveUserCue / loadUserCues round-trip", () => {
  it("saves a cue and reads it back, persisted under the stage key", () => {
    const saved = saveUserCue("track-1", { timeSec: 42, label: "Vocal in" });
    expect(saved).toEqual([{ timeSec: 42, label: "Vocal in" }]);
    expect(loadUserCues("track-1")).toEqual([
      { timeSec: 42, label: "Vocal in" },
    ]);
    const raw = JSON.parse(store.get(KEY) ?? "{}") as Record<string, unknown>;
    expect(raw["track-1"]).toEqual([{ timeSec: 42, label: "Vocal in" }]);
  });

  it("keeps the list sorted by time as cues are added", () => {
    saveUserCue("track-1", { timeSec: 50, label: "C" });
    saveUserCue("track-1", { timeSec: 10, label: "A" });
    const saved = saveUserCue("track-1", { timeSec: 30, label: "B" });
    expect(saved.map((c) => c.label)).toEqual(["A", "B", "C"]);
    expect(loadUserCues("track-1").map((c) => c.timeSec)).toEqual([10, 30, 50]);
  });

  it("keeps different tracks independent", () => {
    saveUserCue("track-1", { timeSec: 10, label: "One" });
    saveUserCue("track-2", { timeSec: 20, label: "Two" });
    expect(loadUserCues("track-1")).toEqual([{ timeSec: 10, label: "One" }]);
    expect(loadUserCues("track-2")).toEqual([{ timeSec: 20, label: "Two" }]);
  });

  it("recovers from corrupt storage on save and overwrites it", () => {
    store.set(KEY, "}{corrupt");
    const saved = saveUserCue("track-1", { timeSec: 7, label: "Fresh" });
    expect(saved).toEqual([{ timeSec: 7, label: "Fresh" }]);
    expect(loadUserCues("track-1")).toEqual([{ timeSec: 7, label: "Fresh" }]);
  });
});

describe("saveUserCue dedupe", () => {
  it("replaces an existing cue within 0.5s instead of stacking", () => {
    saveUserCue("track-1", { timeSec: 10, label: "Old" });
    const saved = saveUserCue("track-1", {
      timeSec: 10.4,
      label: "New",
    });
    expect(saved).toEqual([{ timeSec: 10.4, label: "New" }]);
  });

  it("replaces at exactly 0.5s away", () => {
    saveUserCue("track-1", { timeSec: 10, label: "Old" });
    const saved = saveUserCue("track-1", {
      timeSec: 10.5,
      label: "New",
    });
    expect(saved).toEqual([{ timeSec: 10.5, label: "New" }]);
  });

  it("appends when the new cue is more than 0.5s from every existing cue", () => {
    saveUserCue("track-1", { timeSec: 10, label: "Old" });
    const saved = saveUserCue("track-1", {
      timeSec: 10.6,
      label: "Separate",
    });
    expect(saved).toEqual([
      { timeSec: 10, label: "Old" },
      { timeSec: 10.6, label: "Separate" },
    ]);
  });

  it("replaces the nearest cue when several are candidates", () => {
    saveUserCue("track-1", { timeSec: 10, label: "A" });
    saveUserCue("track-1", { timeSec: 10.9, label: "B" });
    // 10.6 is 0.6 from A (no) and 0.3 from B (yes, nearest).
    const saved = saveUserCue("track-1", { timeSec: 10.6, label: "B2" });
    expect(saved).toEqual([
      { timeSec: 10, label: "A" },
      { timeSec: 10.6, label: "B2" },
    ]);
  });
});

describe("saveUserCue cap", () => {
  function fill(trackId: string) {
    for (let i = 0; i < 8; i += 1) {
      saveUserCue(trackId, { timeSec: i * 10, label: `Cue ${i}` });
    }
  }

  it("caps the list at 8, dropping a new cue that would exceed it", () => {
    fill("track-1");
    const before = loadUserCues("track-1");
    expect(before).toHaveLength(8);
    const saved = saveUserCue("track-1", { timeSec: 95, label: "Ninth" });
    expect(saved).toEqual(before);
    expect(loadUserCues("track-1")).toEqual(before);
  });

  it("still allows a replacement when the list is full", () => {
    fill("track-1");
    const saved = saveUserCue("track-1", {
      timeSec: 30.3,
      label: "Replaced",
    });
    expect(saved).toHaveLength(8);
    expect(saved.find((c) => c.label === "Replaced")?.timeSec).toBe(30.3);
    expect(saved.some((c) => c.label === "Cue 3")).toBe(false);
  });
});

describe("saveUserCue time guards", () => {
  it("clamps a negative time to 0", () => {
    const saved = saveUserCue("track-1", { timeSec: -5, label: "Start" });
    expect(saved).toEqual([{ timeSec: 0, label: "Start" }]);
  });

  it("rejects a NaN time, returning the current list unchanged", () => {
    saveUserCue("track-1", { timeSec: 10, label: "Kept" });
    const saved = saveUserCue("track-1", {
      timeSec: Number.NaN,
      label: "Bogus",
    });
    expect(saved).toEqual([{ timeSec: 10, label: "Kept" }]);
    expect(loadUserCues("track-1")).toEqual([{ timeSec: 10, label: "Kept" }]);
  });

  it("rejects an infinite time, returning the current list unchanged", () => {
    const saved = saveUserCue("track-1", {
      timeSec: Number.POSITIVE_INFINITY,
      label: "Bogus",
    });
    expect(saved).toEqual([]);
    expect(loadUserCues("track-1")).toEqual([]);
  });
});

describe("clearUserCues", () => {
  it("removes only that track's cues", () => {
    saveUserCue("track-1", { timeSec: 10, label: "One" });
    saveUserCue("track-2", { timeSec: 20, label: "Two" });
    clearUserCues("track-1");
    expect(loadUserCues("track-1")).toEqual([]);
    expect(loadUserCues("track-2")).toEqual([{ timeSec: 20, label: "Two" }]);
  });

  it("does not throw for an unknown track or corrupt storage", () => {
    expect(() => clearUserCues("never-saved")).not.toThrow();
    store.set(KEY, "not json");
    expect(() => clearUserCues("track-1")).not.toThrow();
  });
});

describe("unavailable localStorage", () => {
  it("survives a localStorage whose access throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
      clear: () => {
        throw new Error("denied");
      },
      key: () => null,
      length: 0,
    };
    installStorage(throwing);
    try {
      expect(loadUserCues("track-1")).toEqual([]);
      expect(() =>
        saveUserCue("track-1", { timeSec: 5, label: "Attempt" }),
      ).not.toThrow();
      expect(saveUserCue("track-1", { timeSec: 5, label: "Attempt" })).toEqual([
        { timeSec: 5, label: "Attempt" },
      ]);
      expect(() => clearUserCues("track-1")).not.toThrow();
    } finally {
      installStorage(localStorageMock);
    }
  });
});
