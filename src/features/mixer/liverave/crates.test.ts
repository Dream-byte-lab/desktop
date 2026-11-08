// crates.test.ts — band tables + the weight-0 class (wave item 7).

import { describe, expect, it } from "vitest";
import { authorCandidates } from "./authors";
import {
  autonomousExclusion,
  crateContextFor,
  crateWeight,
  CRATE_TABLE_V1,
  CRATES_VERSION,
  setPositionBand,
} from "./crates";
import { NEUTRAL_SHAPING } from "./shaping";
import { clubA, clubB, distantA, distantB } from "./testFixtures";

describe("crates — bands", () => {
  it("set position bands follow the arc quarters", () => {
    expect(setPositionBand(0.1)).toBe("opening");
    expect(setPositionBand(0.4)).toBe("building");
    expect(setPositionBand(0.7)).toBe("peak");
    expect(setPositionBand(0.9)).toBe("wind-down");
  });

  it("context derives direction and key distance from facts", () => {
    const ctx = crateContextFor(clubA, clubB, 0.7);
    expect(ctx.setPosition).toBe("peak");
    expect(["same", "near"]).toContain(ctx.keyDistance);
    const far = crateContextFor(distantA, distantB, 0.7);
    expect(far.keyDistance).toBe("far");
  });

  it("the table is versioned data and weights multiply across bands", () => {
    expect(CRATES_VERSION).toBe("crates-v1");
    const { candidates } = authorCandidates(clubA, clubB, {
      arcPosition: 0.7,
      shaping: NEUTRAL_SHAPING,
    });
    const drop = candidates.find((c) => c.family === "drop-cut");
    expect(drop).toBeDefined();
    const peakWeight = crateWeight(drop!, crateContextFor(clubA, clubB, 0.7));
    const openingWeight = crateWeight(
      drop!,
      crateContextFor(clubA, clubB, 0.05),
    );
    expect(peakWeight).toBeGreaterThan(openingWeight);
  });
});

describe("crates — the weight-0 class", () => {
  it("spinback carriers are excluded from the autonomous roll", () => {
    const { candidates } = authorCandidates(clubA, clubB, {
      arcPosition: 0.5,
      shaping: NEUTRAL_SHAPING,
    });
    const withSpinback = candidates.find((c) =>
      c.blocks.some((b) => b.type === "jog" && b.kind === "spinback"),
    );
    if (withSpinback) {
      expect(autonomousExclusion(withSpinback)).toContain("weight-0");
    }
    const plain = candidates.find((c) => c.family === "blend");
    expect(plain).toBeDefined();
    expect(autonomousExclusion(plain!)).toBeNull();
    // The table itself never carries a literal 0: weight-0 is
    // structural, not a row a future editor can fat-finger away.
    for (const band of Object.values(CRATE_TABLE_V1.bySetPosition)) {
      for (const value of Object.values(band)) {
        expect(value).toBeGreaterThan(0);
      }
    }
  });
});
