// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  applyCustomCover,
  clearCustomCover,
  computeCoverSize,
  getCustomCover,
  getPinnedPlaylistIds,
  isPlaylistPinned,
  orderPinnedFirst,
  pinPlaylist,
  resetPlaylistIdentityCacheForTests,
  setCustomCover,
  togglePlaylistPin,
  unpinPlaylist,
} from "./playlistIdentity";

beforeEach(() => {
  localStorage.clear();
  resetPlaylistIdentityCacheForTests();
});

describe("custom playlist covers", () => {
  it("persist across a cache reset (app restart)", () => {
    expect(setCustomCover("pl1", "data:image/jpeg;base64,AAA")).toBe(true);
    resetPlaylistIdentityCacheForTests();
    expect(getCustomCover("pl1")).toBe("data:image/jpeg;base64,AAA");
  });

  it("reset removes the cover and restores nothing-to-see", () => {
    setCustomCover("pl1", "data:image/jpeg;base64,AAA");
    clearCustomCover("pl1");
    resetPlaylistIdentityCacheForTests();
    expect(getCustomCover("pl1")).toBeUndefined();
  });

  it("applyCustomCover replaces the derived collage with the single custom image", () => {
    setCustomCover("pl1", "data:image/jpeg;base64,AAA");
    const summary = {
      id: "pl1",
      title: "Mix",
      coverUrl: "https://img/a",
      coverUrls: ["https://img/a", "https://img/b"],
    };
    const applied = applyCustomCover(summary);
    expect(applied.coverUrl).toBe("data:image/jpeg;base64,AAA");
    expect(applied.coverUrls).toEqual(["data:image/jpeg;base64,AAA"]);
    // input untouched
    expect(summary.coverUrls).toHaveLength(2);
  });

  it("applyCustomCover is a no-op without a custom cover", () => {
    const summary = { id: "pl9", coverUrl: "x", coverUrls: ["x"] };
    expect(applyCustomCover(summary)).toBe(summary);
  });
});

describe("playlist pinning", () => {
  it("pins persist in pin-time order across a cache reset", () => {
    pinPlaylist("pl2");
    pinPlaylist("pl1");
    resetPlaylistIdentityCacheForTests();
    expect(getPinnedPlaylistIds()).toEqual(["pl2", "pl1"]);
    expect(isPlaylistPinned("pl1")).toBe(true);
  });

  it("toggle pins then unpins; duplicate pins do not duplicate", () => {
    expect(togglePlaylistPin("pl1")).toBe(true);
    pinPlaylist("pl1");
    expect(getPinnedPlaylistIds()).toEqual(["pl1"]);
    expect(togglePlaylistPin("pl1")).toBe(false);
    expect(getPinnedPlaylistIds()).toEqual([]);
    unpinPlaylist("pl1");
    expect(getPinnedPlaylistIds()).toEqual([]);
  });

  it("orderPinnedFirst puts pinned first in pin order, stable elsewhere", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(orderPinnedFirst(items, ["c", "a"]).map((i) => i.id)).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("orderPinnedFirst ignores pins not in the list and copies when unpinned", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(orderPinnedFirst(items, ["zzz"]).map((i) => i.id)).toEqual([
      "a",
      "b",
    ]);
    const copy = orderPinnedFirst(items, []);
    expect(copy).toEqual(items);
    expect(copy).not.toBe(items);
  });
});

describe("computeCoverSize", () => {
  it("caps the long edge at 512 preserving aspect", () => {
    expect(computeCoverSize(1024, 512)).toEqual({ width: 512, height: 256 });
    expect(computeCoverSize(300, 900)).toEqual({ width: 171, height: 512 });
  });

  it("leaves small images alone and rejects empty sizes", () => {
    expect(computeCoverSize(200, 100)).toEqual({ width: 200, height: 100 });
    expect(computeCoverSize(0, 100)).toEqual({ width: 0, height: 0 });
  });
});
