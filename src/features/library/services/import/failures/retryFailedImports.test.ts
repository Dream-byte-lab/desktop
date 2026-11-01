import { describe, expect, it, vi } from "vitest";
import type { FailedImportEntry } from "./failedImportsStore";
import { retryFailedImports } from "./retryFailedImports";

const entry = (sourceId: string, title: string): FailedImportEntry => ({
  key: `spotify:${sourceId}`,
  source: "spotify",
  sourceTrack: { sourceId, title, artists: ["Artist"], durationMs: 1000 },
  reason: "no_catalog_candidates",
  stage: "matching",
  importTitle: "Road trip",
  failedAt: "2026-11-01T00:00:00.000Z",
  attempts: 1,
});

describe("retryFailedImports", () => {
  it("recovers confident matches and keeps the rest, with reasons", async () => {
    const match = vi.fn(async (source: { sourceId: string }) => {
      if (source.sourceId === "found-now") {
        return {
          status: "approved" as const,
          track: { id: "yt-1", title: "Found", artists: [] } as never,
          score: 99,
        };
      }
      if (source.sourceId === "still-uncertain") {
        return {
          status: "pending" as const,
          reason: "low_confidence_match" as const,
        };
      }
      return {
        status: "pending" as const,
        reason: "no_catalog_candidates" as const,
      };
    });

    const outcome = await retryFailedImports(
      [
        entry("found-now", "A"),
        entry("still-uncertain", "B"),
        entry("still-missing", "C"),
      ],
      match as never,
    );

    expect(outcome.matched.map((m) => m.entry.key)).toEqual([
      "spotify:found-now",
    ]);
    expect(outcome.stillFailing).toEqual([
      {
        entry: expect.objectContaining({ key: "spotify:still-uncertain" }),
        reason: "low_confidence_match",
      },
      {
        entry: expect.objectContaining({ key: "spotify:still-missing" }),
        reason: "no_catalog_candidates",
      },
    ]);
  });

  it("treats a lookup explosion as still failing, not as a crash", async () => {
    const match = vi.fn(async () => {
      throw new Error("network down");
    });
    const outcome = await retryFailedImports([entry("x", "A")], match as never);
    expect(outcome.matched).toEqual([]);
    expect(outcome.stillFailing[0].reason).toBe("catalog_lookup_failed");
  });
});
