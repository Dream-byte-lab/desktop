// ear.test.ts — outcome labels, kept distinct (wave item 5).

import { describe, expect, it } from "vitest";
import { createInMemoryOutcomeStore, TransitionEar, type EarJoin } from "./ear";

function ear() {
  let t = 1000;
  return new TransitionEar(createInMemoryOutcomeStore(), () => (t += 10));
}

function join(recordAt: number, from: string, to: string): EarJoin {
  return { recordAt, pairTrackIds: [from, to], incomingTrackId: to };
}

describe("TransitionEar", () => {
  it("a track that plays through to the next join completes", () => {
    const e = ear();
    e.joinLanded(join(1, "a", "b"));
    e.joinLanded(join(2, "b", "c"));
    expect(e.outcomesFor(1).map((o) => o.label)).toEqual(["completion"]);
    expect(e.outcomesFor(2)).toEqual([]);
  });

  it("skip-in-blend is a transition failure, with its position", () => {
    const e = ear();
    e.joinLanded(join(1, "a", "b"));
    e.skipInBlend(3_200);
    const [outcome] = e.outcomesFor(1);
    expect(outcome.label).toBe("skip-in-blend");
    expect(outcome.positionMs).toBe(3_200);
  });

  it("skip-after is a track event and is never merged with skip-in-blend", () => {
    const e = ear();
    e.joinLanded(join(1, "a", "b"));
    e.skipAfter(45_000);
    expect(e.outcomesFor(1).map((o) => o.label)).toEqual(["skip-after"]);
    // And a skipped track does not ALSO earn a completion when
    // the next join leaves from it.
    e.joinLanded(join(2, "b", "c"));
    expect(e.outcomesFor(1).map((o) => o.label)).toEqual(["skip-after"]);
  });

  it("the same track coming straight back is a repeat", () => {
    const e = ear();
    e.joinLanded(join(1, "a", "b"));
    e.joinLanded(join(2, "c", "b"));
    expect(e.outcomesFor(1).map((o) => o.label)).toEqual(["repeat"]);
  });

  it("replay is positive evidence recorded against the original join", () => {
    const e = ear();
    e.joinLanded(join(1, "a", "b"));
    e.joinLanded(join(2, "b", "c"));
    e.replay(1, ["a", "b"]);
    expect(e.outcomesFor(1).map((o) => o.label)).toEqual([
      "completion",
      "replay",
    ]);
  });
});
