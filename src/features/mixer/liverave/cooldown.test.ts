// cooldown.test.ts — the Shelf's bookkeeping (wave item 8).

import { describe, expect, it } from "vitest";
import {
  ARTIST_COOLDOWN,
  CooldownShelf,
  createInMemoryShelfStore,
  TECHNIQUE_FAILURE_COOLDOWN,
  techniqueKeyOf,
} from "./cooldown";

function shelf(mode = "autonomous") {
  return new CooldownShelf(createInMemoryShelfStore(), mode);
}

describe("CooldownShelf", () => {
  it("never binds the first transition", () => {
    const s = shelf();
    expect(
      s.benchFor({ artist: "A", techniqueKey: "flare", trackId: "t1" }),
    ).toBeNull();
  });

  it("a played technique sits out its success cooldown, then returns", () => {
    const s = shelf();
    s.noteTransition({ artist: "A", techniqueKey: "flare", trackId: "t1" });
    expect(
      s.benchFor({ artist: "B", techniqueKey: "flare", trackId: "t2" })?.kind,
    ).toBe("technique");
    s.noteTransition({ artist: "B", techniqueKey: null, trackId: "t2" });
    expect(
      s.benchFor({ artist: "C", techniqueKey: "flare", trackId: "t3" })?.kind,
    ).toBe("technique");
    s.noteTransition({ artist: "C", techniqueKey: null, trackId: "t3" });
    expect(
      s.benchFor({ artist: "D", techniqueKey: "flare", trackId: "t4" }),
    ).toBeNull();
  });

  it("failure benches far longer than success", () => {
    const s = shelf();
    s.noteTransition({ artist: "A", techniqueKey: "crab", trackId: "t1" });
    s.noteJoinFailure("crab");
    for (let i = 0; i < TECHNIQUE_FAILURE_COOLDOWN - 1; i += 1) {
      s.noteTransition({
        artist: `X${i}`,
        techniqueKey: null,
        trackId: `tx${i}`,
      });
      expect(
        s.benchFor({ artist: "Z", techniqueKey: "crab", trackId: "tz" }),
      ).not.toBeNull();
    }
    s.noteTransition({ artist: "Y", techniqueKey: null, trackId: "ty" });
    expect(
      s.benchFor({ artist: "Z", techniqueKey: "crab", trackId: "tz" }),
    ).toBeNull();
  });

  it("artists sit out; core blend families are never technique-benched", () => {
    const s = shelf();
    s.noteTransition({ artist: "A", techniqueKey: null, trackId: "t1" });
    const bench = s.benchFor({
      artist: "A",
      techniqueKey: null,
      trackId: "t2",
    });
    expect(bench?.kind).toBe("artist");
    expect(bench?.reason).toContain("cooldown shelf");
    expect(techniqueKeyOf({ family: "blend" })).toBeNull();
    expect(techniqueKeyOf({ family: "drop-cut" })).toBe("drop-cut");
    expect(techniqueKeyOf({ family: "blend", technique: "baby" })).toBe("baby");
    void ARTIST_COOLDOWN;
  });

  it("state persists per mode through the store", () => {
    const store = createInMemoryShelfStore();
    const first = new CooldownShelf(store, "club");
    first.noteTransition({ artist: "A", techniqueKey: "flare", trackId: "t1" });
    const reopened = new CooldownShelf(store, "club");
    expect(reopened.transitionIndex).toBe(1);
    expect(
      reopened.benchFor({ artist: "B", techniqueKey: "flare", trackId: "t2" }),
    ).not.toBeNull();
    const otherMode = new CooldownShelf(store, "radio");
    expect(otherMode.transitionIndex).toBe(0);
    const view = reopened.inspect();
    expect(view.mode).toBe("club");
    expect(view.lines.some((line) => line.includes("BENCHED NOW"))).toBe(true);
  });
});
