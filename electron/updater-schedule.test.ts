import { describe, expect, it } from "vitest";
import { RELEASE_UPDATE_CHECK_INTERVAL_MS } from "./updater-schedule";

describe("RELEASE_UPDATE_CHECK_INTERVAL_MS", () => {
  it("is 20 minutes", () => {
    expect(RELEASE_UPDATE_CHECK_INTERVAL_MS).toBe(20 * 60 * 1000);
    expect(RELEASE_UPDATE_CHECK_INTERVAL_MS).toBe(1_200_000);
  });

  it("is not the old 6-hour value", () => {
    expect(RELEASE_UPDATE_CHECK_INTERVAL_MS).not.toBe(6 * 60 * 60 * 1000);
  });
});
