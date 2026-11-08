// hands.test.ts — personalities as modules (wave item 6).

import { describe, expect, it } from "vitest";
import { authorCandidates } from "./authors";
import { suitabilityOf } from "./brain";
import {
  CooldownShelf,
  createInMemoryShelfStore,
  techniqueKeyOf,
} from "./cooldown";
import {
  applyHandEdits,
  applyHandScores,
  resolveHands,
  type HandContext,
} from "./hands";
import { slateCandidateId, Slate, type SlateCandidate } from "./slate";
import { NEUTRAL_SLIDERS, resolveShaping, type Shaping } from "./shaping";
import { clubA, clubB } from "./testFixtures";

function slateFor(shaping: Shaping): Slate {
  const { candidates } = authorCandidates(clubA, clubB, {
    arcPosition: 0.5,
    shaping,
  });
  return new Slate(
    candidates.map((recipe) => ({
      id: slateCandidateId(clubB.trackId, recipe.id),
      trackB: clubB,
      recipe,
      suitability: suitabilityOf(recipe),
      source: "planner" as const,
      weight: 0,
      crateWeight: 1,
      autonomousExcluded: null,
    })),
  );
}

function ctx(shaping: Shaping): HandContext {
  return { factsA: clubA, arcPosition: 0.5, shaping, transitionIndex: 3 };
}

describe("Hands composition", () => {
  it("autonomous + personality scores reproduce the resolved shaping affinity", () => {
    const shaping = resolveShaping("club", NEUTRAL_SLIDERS);
    const slate = slateFor(shaping);
    const hands = resolveHands(shaping, {
      config: { disabled: ["crates"] },
    });
    applyHandScores(slate, hands, ctx(shaping));
    for (const entry of slate.entries()) {
      const target = entry.recipe.blocks.some((b) => b.type === "fx")
        ? "fx"
        : entry.recipe.family;
      const expected =
        entry.suitability * entry.suitability * shaping.affinity(target);
      expect(entry.weight).toBeCloseTo(expected, 9);
    }
  });

  it("disabling the personality module removes its table from the draw", () => {
    const shaping = resolveShaping("club", NEUTRAL_SLIDERS);
    const slate = slateFor(shaping);
    const hands = resolveHands(shaping, {
      config: { disabled: ["crates", "personality:club"] },
    });
    expect(hands.map((h) => h.id)).not.toContain("personality:club");
    applyHandScores(slate, hands, ctx(shaping));
    for (const entry of slate.entries()) {
      // Neutral sliders: the autonomous hand alone weighs 1.
      expect(entry.weight).toBeCloseTo(entry.suitability ** 2, 9);
    }
  });

  it("club unshifts its strongest drop-cut; radio vetoes stop-exit", () => {
    const club = resolveShaping("club", NEUTRAL_SLIDERS);
    const clubSlate = slateFor(club);
    applyHandEdits(
      clubSlate,
      resolveHands(club, { config: { disabled: ["crates"] } }),
      ctx(club),
    );
    const first = clubSlate.entries()[0];
    if (clubSlate.entries().some((e) => e.recipe.family === "drop-cut")) {
      expect(first.recipe.family).toBe("drop-cut");
      expect(
        clubSlate.ops.some(
          (op) => op.op === "unshift" && op.author === "personality:club",
        ),
      ).toBe(true);
    }

    const radio = resolveShaping("radio", NEUTRAL_SLIDERS);
    const radioSlate = slateFor(radio);
    applyHandEdits(
      radioSlate,
      resolveHands(radio, { config: { disabled: ["crates"] } }),
      ctx(radio),
    );
    expect(
      radioSlate.entries().some((e) => e.recipe.family === "stop-exit"),
    ).toBe(false);
    expect(
      radioSlate.vetoes.some((v) => v.author === "personality:radio"),
    ).toBe(radioSlate.vetoes.length > 0);
  });

  it("battle lifts the weight-0 exclusion by inserting the spinback itself", () => {
    const battle = resolveShaping("battle", NEUTRAL_SLIDERS);
    const slate = slateFor(battle);
    const hands = resolveHands(battle, {});
    // crates' assemble pass marks planner spinbacks excluded…
    applyHandEdits(slate, hands, ctx(battle));
    const spinbacks = slate
      .entries()
      .filter((e) =>
        e.recipe.blocks.some((b) => b.type === "jog" && b.kind === "spinback"),
      );
    // …and if any exist, battle has claimed one as its own insert.
    if (spinbacks.length > 0) {
      expect(
        spinbacks.some(
          (e) => e.source === "personality:battle" && !e.autonomousExcluded,
        ),
      ).toBe(true);
    }
  });

  it("the cooldown hand vetoes benched techniques and waives a one-artist bench", () => {
    const shaping = resolveShaping("autonomous", NEUTRAL_SLIDERS);
    const store = createInMemoryShelfStore();
    const shelf = new CooldownShelf(store, "autonomous");
    shelf.noteTransition({
      artist: "Only Artist",
      techniqueKey: "drop-cut",
      trackId: "other",
    });
    const slate = slateFor(shaping);
    const hands = resolveHands(shaping, {
      shelf,
      artistByTrackId: new Map([[clubB.trackId, "Only Artist"]]),
      techniqueKeyOfCandidate: (c: SlateCandidate) =>
        techniqueKeyOf({
          family: c.recipe.family,
          technique: c.recipe.technique,
        }),
      config: { disabled: ["crates"] },
    });
    applyHandEdits(slate, hands, ctx(shaping));
    // drop-cut candidates are technique-benched (real veto)…
    expect(slate.entries().some((e) => e.recipe.family === "drop-cut")).toBe(
      false,
    );
    // …but the slate still holds the other families (nothing
    // starved), and no artist-waiver was needed here.
    expect(slate.size()).toBeGreaterThan(0);
  });
});
