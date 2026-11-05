import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BehaviourRecord } from "@/features/mixer/liverave/storage";

// The behaviour log behind storage.ts's read API is the fake's
// whole surface: the reader consumes listBehaviour() and nothing
// else from the new engine.
const logHolder: { records: unknown[] } = { records: [] };

vi.mock("@/features/mixer/liverave/storage", () => ({
  listBehaviour: vi.fn(async () => logHolder.records),
}));

import { listBehaviour } from "@/features/mixer/liverave/storage";
import { readJoinSummary } from "./joinsReader";

function record(reason: BehaviourRecord["reason"]): BehaviourRecord {
  return {
    at: 1_700_000_000_000,
    family: "blend",
    fxKinds: [],
    pairTrackIds: ["track-a", "track-b"],
    suitability: 0.8,
    poolSize: 4,
    reason,
  };
}

const EMPTY_SUMMARY = {
  performed: 0,
  userAct: 0,
  fallbackUnprepared: 0,
  fallbackInvalid: 0,
  degradedUntrusted: 0,
  setEnd: 0,
};

describe("readJoinSummary — the dashboard's DJ block over the behaviour log", () => {
  beforeEach(() => {
    logHolder.records = [];
  });

  it("is null when the log holds no records at all", async () => {
    expect(await readJoinSummary()).toBeNull();
  });

  it("counts performed and user-act entries under their own names", async () => {
    logHolder.records = [
      record("performed"),
      record("performed"),
      record("user-act"),
    ];
    expect(await readJoinSummary()).toEqual({
      ...EMPTY_SUMMARY,
      performed: 2,
      userAct: 1,
    });
  });

  it("counts fallbacks and degradations by their recorded reason, never as performed joins", async () => {
    logHolder.records = [
      record("performed"),
      record("fallback-unprepared"),
      record("fallback-unprepared"),
      record("fallback-invalid"),
      record("degraded-untrusted"),
      record("set-end"),
    ];
    expect(await readJoinSummary()).toEqual({
      ...EMPTY_SUMMARY,
      performed: 1,
      fallbackUnprepared: 2,
      fallbackInvalid: 1,
      degradedUntrusted: 1,
      setEnd: 1,
    });
  });

  it("a log of only fallbacks still yields a summary (the block exists, no joins sounded)", async () => {
    logHolder.records = [record("fallback-unprepared")];
    expect(await readJoinSummary()).toEqual({
      ...EMPTY_SUMMARY,
      fallbackUnprepared: 1,
    });
  });

  it("the summary carries no grade-shaped fields at all", async () => {
    logHolder.records = [record("performed")];
    const summary = await readJoinSummary();
    expect(summary).not.toBeNull();
    expect(Object.keys(summary ?? {}).sort()).toEqual([
      "degradedUntrusted",
      "fallbackInvalid",
      "fallbackUnprepared",
      "performed",
      "setEnd",
      "userAct",
    ]);
  });

  it("skips malformed entries instead of crashing or counting them", async () => {
    logHolder.records = [
      null,
      "not a record",
      { noReason: true },
      record("performed"),
    ];
    const summary = await readJoinSummary();
    expect(summary?.performed).toBe(1);
  });

  it("is null when every entry is malformed", async () => {
    logHolder.records = [null, 42, { family: "blend" }];
    expect(await readJoinSummary()).toBeNull();
  });

  it("is null when the log cannot be read at all, instead of rejecting", async () => {
    vi.mocked(listBehaviour).mockRejectedValueOnce(new Error("db gone"));
    expect(await readJoinSummary()).toBeNull();
  });
});
