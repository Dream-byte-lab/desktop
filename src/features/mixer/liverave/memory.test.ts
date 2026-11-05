import { describe, expect, it } from "vitest";
import {
  MEMORY_FACTOR_MIN,
  createBehaviourLog,
  createInMemoryBehaviourStore,
  createPerformanceMemory,
} from "./memory";

describe("createPerformanceMemory — factor bounds (design §4 invariant 5)", () => {
  it("an empty memory is neutral: every factor is exactly 1", () => {
    const memory = createPerformanceMemory();
    expect(memory.factorFor({ family: "blend" })).toBe(1);
    expect(
      memory.factorFor({
        family: "scratch-in",
        technique: "crab",
        fxKinds: ["reverb"],
      }),
    ).toBe(1);
  });

  it("repeated families sink toward the 0.55 floor but never below it", () => {
    const memory = createPerformanceMemory();
    memory.record({ family: "blend", fxKinds: [] });
    const once = memory.factorFor({ family: "blend" });
    expect(once).toBeCloseTo(0.775);
    for (let i = 0; i < 20; i += 1) {
      memory.record({ family: "blend", fxKinds: [] });
    }
    const saturated = memory.factorFor({ family: "blend" });
    expect(saturated).toBeGreaterThanOrEqual(MEMORY_FACTOR_MIN);
    expect(saturated).toBeLessThan(0.6);
    // An unrelated family stays near-neutral after the same history:
    // only its absence of repeats matters.
    expect(memory.factorFor({ family: "drop-cut" })).toBe(1);
  });

  it("technique and fx repeats damp more mildly than family repeats", () => {
    const memory = createPerformanceMemory();
    memory.record({
      family: "scratch-in",
      technique: "flare",
      fxKinds: ["reverb"],
    });
    const techniqueOnly = memory.factorFor({
      family: "blend",
      technique: "flare",
    });
    expect(techniqueOnly).toBeCloseTo(0.875);
    const fxOnly = memory.factorFor({ family: "blend", fxKinds: ["reverb"] });
    expect(fxOnly).toBeCloseTo(0.9);
    const all = memory.factorFor({
      family: "scratch-in",
      technique: "flare",
      fxKinds: ["reverb"],
    });
    expect(all).toBeLessThan(techniqueOnly);
    expect(all).toBeGreaterThanOrEqual(MEMORY_FACTOR_MIN);
  });

  it("only the last 12 joins count", () => {
    const memory = createPerformanceMemory();
    for (let i = 0; i < 12; i += 1) {
      memory.record({ family: "blend", fxKinds: [] });
    }
    for (let i = 0; i < 12; i += 1) {
      memory.record({ family: "echo-out", fxKinds: [] });
    }
    // The 12 blends have aged out of the window entirely.
    expect(memory.factorFor({ family: "blend" })).toBe(1);
    expect(memory.factorFor({ family: "echo-out" })).toBeLessThan(0.6);
  });
});

describe("createBehaviourLog", () => {
  it("records performed joins and fallbacks, and distributes counts", () => {
    const log = createBehaviourLog(createInMemoryBehaviourStore());
    log.recordPerformed({
      family: "blend",
      pairTrackIds: ["a", "b"],
      suitability: 0.8,
      poolSize: 12,
      at: 1000,
    });
    log.recordPerformed({
      family: "scratch-in",
      technique: "crab",
      fxKinds: ["slip-roll"],
      pairTrackIds: ["b", "c"],
      suitability: 0.7,
      poolSize: 9,
      at: 2000,
    });
    log.recordFallback({
      family: null,
      pairTrackIds: ["c", "d"],
      suitability: null,
      poolSize: 0,
      reason: "fallback-unprepared",
      at: 3000,
    });
    const records = log.getBehaviourLog();
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ reason: "performed", family: "blend" });
    expect(records[2].reason).toBe("fallback-unprepared");
    const distribution = log.distribution();
    expect(distribution.total).toBe(3);
    expect(distribution.byFamily).toEqual({
      blend: 1,
      "scratch-in": 1,
      none: 1,
    });
    expect(distribution.byTechnique).toEqual({ crab: 1 });
    expect(distribution.byReason).toEqual({
      performed: 2,
      "fallback-unprepared": 1,
    });
  });

  it("the in-memory store caps at 400 records by default", () => {
    const store = createInMemoryBehaviourStore();
    const log = createBehaviourLog(store);
    for (let i = 0; i < 450; i += 1) {
      log.recordPerformed({
        family: "blend",
        pairTrackIds: ["a", "b"],
        suitability: 0.5,
        poolSize: 3,
        at: i,
      });
    }
    expect(log.getBehaviourLog()).toHaveLength(400);
    expect(log.getBehaviourLog()[0].at).toBe(50);
  });
});
