import { describe, it, expect } from "vitest";
import {
  applyRangeSelection,
  toggleSelectionKey,
  trackSelectionKey,
} from "./trackSelection";

describe("trackSelectionKey", () => {
  it("prefers the playlist item id, falls back to the track id", () => {
    expect(trackSelectionKey({ id: "t1", playlistItemId: "i1" })).toBe("i1");
    expect(trackSelectionKey({ id: "t1" })).toBe("t1");
  });
});

describe("toggleSelectionKey", () => {
  it("adds then removes without mutating the input", () => {
    const start = new Set<string>();
    const added = toggleSelectionKey(start, "a");
    expect([...added]).toEqual(["a"]);
    expect(start.size).toBe(0);
    expect(toggleSelectionKey(added, "a").size).toBe(0);
  });
});

describe("applyRangeSelection", () => {
  const keys = ["a", "b", "c", "d", "e"];

  it("selects the inclusive range in either direction", () => {
    expect(
      [...applyRangeSelection(new Set(), keys, "b", "d", true)].sort(),
    ).toEqual(["b", "c", "d"]);
    expect(
      [...applyRangeSelection(new Set(), keys, "d", "b", true)].sort(),
    ).toEqual(["b", "c", "d"]);
  });

  it("deselects a range when select is false", () => {
    const all = new Set(keys);
    expect([...applyRangeSelection(all, keys, "b", "c", false)].sort()).toEqual(
      ["a", "d", "e"],
    );
  });

  it("degrades to the target alone without a known anchor", () => {
    expect([...applyRangeSelection(new Set(), keys, null, "c", true)]).toEqual([
      "c",
    ]);
    expect([
      ...applyRangeSelection(new Set(), keys, "missing", "c", true),
    ]).toEqual(["c"]);
  });
});
