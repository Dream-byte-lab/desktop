import { describe, expect, it } from "vitest";
import {
  FailedImportsStore,
  failedImportReasonWords,
  type FailedImportStorage,
} from "./failedImportsStore";

function memoryStorage(): FailedImportStorage & { value: string | null } {
  return {
    value: null,
    read() {
      return this.value;
    },
    write(value: string) {
      this.value = value;
    },
  };
}

const failure = (sourceId: string, title: string) => ({
  source: "spotify" as const,
  sourceTrack: {
    sourceId,
    title,
    artists: ["Artist"],
    album: "Album",
    durationMs: 200000,
  },
  reason: "no_catalog_candidates",
  stage: "matching" as const,
  importTitle: "Road trip",
  failedAt: "2026-11-01T00:00:00.000Z",
});

describe("FailedImportsStore", () => {
  it("keeps every failed song with its reason", () => {
    const store = new FailedImportsStore(memoryStorage());
    store.record([failure("t1", "Lost Song"), failure("t2", "Other Song")]);
    const entries = store.list();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      key: "spotify:t1",
      reason: "no_catalog_candidates",
      importTitle: "Road trip",
      attempts: 1,
    });
    expect(entries[0].sourceTrack.title).toBe("Lost Song");
  });

  it("updates one entry when the same song fails again", () => {
    const store = new FailedImportsStore(memoryStorage());
    store.record([failure("t1", "Lost Song")]);
    store.record([
      { ...failure("t1", "Lost Song"), reason: "catalog_lookup_failed" },
    ]);
    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].attempts).toBe(2);
    expect(entries[0].reason).toBe("catalog_lookup_failed");
  });

  it("persists across store instances and removes on request", () => {
    const storage = memoryStorage();
    new FailedImportsStore(storage).record([failure("t1", "Lost Song")]);
    const reopened = new FailedImportsStore(storage);
    expect(reopened.list()).toHaveLength(1);
    reopened.remove(["spotify:t1"]);
    expect(reopened.list()).toHaveLength(0);
    expect(new FailedImportsStore(storage).list()).toHaveLength(0);
  });

  it("speaks plainly about reasons", () => {
    expect(failedImportReasonWords("no_catalog_candidates")).toBe(
      "No matching song was found",
    );
    expect(failedImportReasonWords("save_failed")).toContain(
      "could not be saved",
    );
    expect(failedImportReasonWords("something_new")).toContain(
      "could not be imported",
    );
  });
});
