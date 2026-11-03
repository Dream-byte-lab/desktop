import { describe, expect, it } from "vitest";
import { RELEASE_UPDATE_CHECK_INTERVAL_MS } from "./updater-schedule";

describe("RELEASE_UPDATE_CHECK_INTERVAL_MS", () => {
  it("is 6 hours", () => {
    expect(RELEASE_UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    expect(RELEASE_UPDATE_CHECK_INTERVAL_MS).toBe(21_600_000);
  });

  it("is not the 20-minute value", () => {
    expect(RELEASE_UPDATE_CHECK_INTERVAL_MS).not.toBe(1_200_000);
  });
});
