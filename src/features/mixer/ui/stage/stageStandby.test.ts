import { describe, expect, it } from "vitest";
import { deckRoleLabel } from "./stageData";

// Interface Build 6 — the standby deck's role line. The label is
// the honest half of HD-4's standby-truth gap that the UI layer
// can close on its own: it never claims the standby panel's track
// is loaded on the deck (only the session knows that — see the
// seam requests in the build report), and during a blend it says
// the deck is sounding its half of the join, which the DJ mode
// store's blending flag does know.

describe("deckRoleLabel", () => {
  it("the playing deck is playing, blend or not", () => {
    expect(deckRoleLabel({ isPlaying: true, blending: false })).toBe("Playing");
    expect(deckRoleLabel({ isPlaying: true, blending: true })).toBe("Playing");
  });

  it("the non-playing deck is the incoming deck while a blend sounds", () => {
    expect(deckRoleLabel({ isPlaying: false, blending: true })).toBe(
      "Incoming — blending in",
    );
  });

  it("otherwise the standby deck is next in queue — not 'loaded'", () => {
    const label = deckRoleLabel({ isPlaying: false, blending: false });
    expect(label).toBe("Standby — next in queue");
    expect(label.toLowerCase()).not.toContain("loaded");
  });
});
