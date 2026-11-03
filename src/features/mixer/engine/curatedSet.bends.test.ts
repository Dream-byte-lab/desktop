import { describe, expect, it } from "vitest";
import type { KeyEstimate } from "./detectKey";
import { assembleSet, type SetCandidate } from "./curatedSet";

// The curation bends (revamp slice R4): assembleSet's three new
// options are the judgement the personality resolver hands in.
// With no options — or with options exactly equal to the shipped
// defaults — the order is the pre-R4 order. With a bend moved, the
// outcome moves: below, BOTH bends are demonstrated on fixtures
// built in curatedSet.test.ts's idiom —
//   - sharedLabelCredit: at 0 the genre-continuity pull vanishes
//     and the pure-score order stands;
//   - nearEqualEpsilon: widened, the band admits a context pick
//     the default band rejects, and its shared-label credit wins.

function key(
  tonic: string,
  mode: "major" | "minor",
  camelot: string,
  pitchClass: number,
) {
  const estimate: KeyEstimate = {
    tonic,
    mode,
    pitchClass,
    camelot,
    confidence: 0.9,
  };
  return estimate;
}

const C_MAJOR = key("C", "major", "8B", 0);
const G_MAJOR = key("G", "major", "9B", 7);
const A_MINOR = key("A", "minor", "8A", 9);

function candidate(
  trackId: string,
  energy: number,
  k: KeyEstimate | null = C_MAJOR,
  bpm = 124,
): SetCandidate {
  return { trackId, bpm, key: k, energy };
}

describe("assembleSet curation bends (R4)", () => {
  // A pool spanning the energy range, keys mostly compatible — the
  // curatedSet.test.ts fixture pool.
  const pool: SetCandidate[] = [
    candidate("peak-1", 0.92),
    candidate("warm-1", 0.28),
    candidate("build-1", 0.55, G_MAJOR),
    candidate("mid-1", 0.62, A_MINOR),
    candidate("warm-2", 0.35, A_MINOR),
    candidate("peak-2", 0.85, G_MAJOR),
    candidate("land-1", 0.3),
    candidate("release-1", 0.58),
    candidate("build-2", 0.5),
    candidate("peak-3", 0.95, A_MINOR),
  ];

  it("explicit options equal to today's defaults return the no-options order", () => {
    expect(
      assembleSet(pool, undefined, {
        nearEqualEpsilon: 0.05,
        sharedLabelCredit: 0.6,
        incumbencyPenalty: 0.1,
      }),
    ).toEqual(assembleSet(pool));
  });

  it("sharedLabelCredit 0 removes the genre-continuity pull", () => {
    // After the opener (Amapiano), "other" and "kin" are EXACT
    // near-equals: same energy fit, same key, same tempo, so both
    // are pure-score leaders. The only thing that can separate
    // them is context — kin continues the opener's label.
    const tied: SetCandidate[] = [
      { ...candidate("opener", 0.3), playlistGenres: ["Amapiano"] },
      { ...candidate("other", 0.55), playlistGenres: ["House"] },
      { ...candidate("kin", 0.55), playlistGenres: ["Amapiano"] },
      candidate("peak", 0.9),
      candidate("closer", 0.3),
    ];
    const byDefault = assembleSet(tied);
    expect(byDefault[1]).toBe("kin");
    expect(byDefault.indexOf("kin")).toBeLessThan(byDefault.indexOf("other"));

    const bent = assembleSet(tied, undefined, { sharedLabelCredit: 0 });
    expect(bent[1]).toBe("other");
    expect(bent.indexOf("other")).toBeLessThan(bent.indexOf("kin"));
  });

  it("a wider nearEqualEpsilon admits a context pick the default band rejects", () => {
    // After the opener, "leader" is the pure-score leader and
    // "kin" sits 0.1 of score behind it (energy 0.60 against the
    // slot's 0.55 want): outside the default 0.05 band, inside a
    // 0.2 band. Kin shares the opener's label, so once the band
    // admits it, its credit (0.6) beats the leader's incumbency.
    const poolWithKin: SetCandidate[] = [
      { ...candidate("opener", 0.3), playlistGenres: ["Amapiano"] },
      { ...candidate("leader", 0.55), playlistGenres: ["House"] },
      { ...candidate("kin", 0.6), playlistGenres: ["Amapiano"] },
      candidate("peak", 0.9),
      candidate("closer", 0.3),
    ];
    const byDefault = assembleSet(poolWithKin);
    expect(byDefault[1]).toBe("leader");

    const widened = assembleSet(poolWithKin, undefined, {
      nearEqualEpsilon: 0.2,
    });
    expect(widened[1]).toBe("kin");
    expect(widened.indexOf("kin")).toBeLessThan(widened.indexOf("leader"));
  });
});
