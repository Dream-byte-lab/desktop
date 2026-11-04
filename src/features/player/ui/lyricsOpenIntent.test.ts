import { describe, expect, it } from "vitest";

import {
  consumeLyricsViewOpenRequest,
  requestLyricsViewOpen,
} from "./lyricsOpenIntent";

describe("lyricsOpenIntent", () => {
  it("reports no request when none was made", () => {
    expect(consumeLyricsViewOpenRequest(1_000)).toBe(false);
  });

  it("delivers a fresh request exactly once", () => {
    requestLyricsViewOpen(2_000);
    expect(consumeLyricsViewOpenRequest(2_100)).toBe(true);
    expect(consumeLyricsViewOpenRequest(2_200)).toBe(false);
  });

  it("ignores a stale request and clears it", () => {
    requestLyricsViewOpen(3_000);
    expect(consumeLyricsViewOpenRequest(3_000 + 60_000)).toBe(false);
    expect(consumeLyricsViewOpenRequest(3_100)).toBe(false);
  });
});
