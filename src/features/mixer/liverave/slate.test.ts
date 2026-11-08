// slate.test.ts — the Slate's operator contract (wave item 3).

import { describe, expect, it } from "vitest";
import type { TrackFacts } from "./facts";
import type { JoinRecipe } from "./recipe";
import {
  drawFromSlate,
  slateCandidateId,
  Slate,
  SLATE_CAP,
  type SlateCandidate,
} from "./slate";
import { clubB } from "./testFixtures";

function recipe(
  id: string,
  family: JoinRecipe["family"] = "blend",
): JoinRecipe {
  return {
    id,
    family,
    outgoing: { trackId: "a", audioHash: null, exitAnchorMs: 0, exitBeat: 0 },
    incoming: { trackId: "b", audioHash: null, entryAnchorMs: 0, entryBeat: 0 },
    overlapBeats: 16,
    rates: { rateA: 1, rateB: 1, beatmatched: true },
    curves: {
      gainA: [],
      gainB: [],
      eqA: { low: [], mid: [], high: [] },
      eqB: { low: [], mid: [], high: [] },
      filterA: [],
      filterB: [],
    },
    blocks: [],
    authored: { evidence: {}, notes: [] },
  } as JoinRecipe;
}

function candidate(
  n: number,
  suitability = 0.8,
  trackB: TrackFacts = clubB,
): SlateCandidate {
  const r = recipe(`r${n}`);
  return {
    id: slateCandidateId(trackB.trackId, r.id),
    trackB,
    recipe: r,
    suitability,
    source: "planner",
    weight: suitability * suitability,
    crateWeight: 1,
    autonomousExcluded: null,
  };
}

describe("Slate operators", () => {
  it("push appends, unshift leads, positions are 1-based", () => {
    const slate = new Slate([candidate(1)]);
    slate.push(candidate(2), "planner");
    slate.unshift(candidate(3), "personality:club");
    expect(slate.size()).toBe(3);
    expect(slate.positionOf(candidate(3).id)).toBe(1);
    expect(slate.positionOf(candidate(1).id)).toBe(2);
    expect(slate.ops.map((op) => op.op)).toContain("unshift");
  });

  it("replace is last-writer-wins on content, keeping position", () => {
    const slate = new Slate([candidate(1), candidate(2)]);
    const swapped = candidate(1, 0.4);
    slate.replace(swapped, "taste");
    expect(slate.get(swapped.id)?.suitability).toBe(0.4);
    expect(slate.positionOf(swapped.id)).toBe(1);
  });

  it("veto tombstones: another author cannot re-add; the vetoer can", () => {
    const slate = new Slate([candidate(1), candidate(2)]);
    expect(
      slate.veto(candidate(1).id, "personality:radio", "too disruptive"),
    ).toBe(true);
    expect(slate.size()).toBe(1);
    expect(slate.push(candidate(1), "planner")).toBe(false);
    expect(slate.push(candidate(1), "personality:radio")).toBe(true);
    expect(slate.vetoes).toHaveLength(1);
    expect(slate.vetoes[0].reason).toBe("too disruptive");
  });

  it("the cap evicts the lowest suitability and logs it", () => {
    const slate = new Slate();
    for (let i = 0; i < SLATE_CAP; i += 1) {
      slate.push(candidate(100 + i, 0.5 + i * 0.01), "planner");
    }
    expect(slate.size()).toBe(SLATE_CAP);
    expect(slate.push(candidate(999, 0.99), "planner")).toBe(true);
    expect(slate.size()).toBe(SLATE_CAP);
    expect(slate.ops.some((op) => op.op === "evict")).toBe(true);
    expect(slate.push(candidate(998, 0.01), "planner")).toBe(false);
  });
});

describe("drawFromSlate", () => {
  it("a single eligible candidate is the pick (argmax of one)", () => {
    const slate = new Slate([candidate(1)]);
    expect(drawFromSlate(slate, () => 0.99)?.id).toBe(candidate(1).id);
  });

  it("autonomously-excluded candidates are not rolled unless asked", () => {
    const excluded = candidate(1, 0.9);
    excluded.autonomousExcluded = "weight-0 class";
    const plain = candidate(2, 0.5);
    const slate = new Slate([excluded, plain]);
    expect(drawFromSlate(slate, () => 0)?.id).toBe(plain.id);
    expect(drawFromSlate(slate, () => 0, { includeExcluded: true })?.id).toBe(
      excluded.id,
    );
  });

  it("weight zero candidates are never drawn; empty eligibility is null", () => {
    const zero = candidate(1);
    zero.weight = 0;
    const slate = new Slate([zero]);
    expect(drawFromSlate(slate, () => 0.5)).toBeNull();
  });
});
