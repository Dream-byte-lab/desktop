import { describe, expect, it } from "vitest";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import { candidatesForPair, type Candidate } from "./candidates";
import { ADVENTUROUS_PROFILE, STANDARD_PROFILE } from "./decisionProfile";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import type { JoinRecord } from "./joinHistory";
import { scoreCandidates } from "./scoring";
import type { RecipeRequest } from "./transitionPlanner";

// Scoring (S5-3): vetoes, weighed evidence, and selection from the
// near-equal band — including the blueprint §5 test for charter
// requirement 2's second half: history must be able to move a score.
// Same fixture arithmetic as the candidates suite (120 BPM).

function key(
  camelot: string,
  pitchClass: number,
  mode: "major" | "minor" = "major",
): KeyEstimate {
  return { tonic: "C", mode, pitchClass, camelot, confidence: 0.9 };
}

function vocalCurve(
  durationSec: number,
  activityAt: (t: number) => number,
  confidence = 1,
): VocalActivityCurve {
  const points = [];
  for (let t = 0; t < durationSec; t += 0.25) {
    points.push({ timeSec: t, activity: activityAt(t), confidence });
  }
  return { windowSec: 0.25, stepSec: 0.25, points };
}

function section(
  kind: TrackSection["kind"],
  startSec: number,
  endSec: number,
  meanRms: number,
  vocalActivity: number,
): TrackSection {
  return {
    kind,
    startSec,
    endSec,
    startBeat: startSec * 2,
    endBeat: endSec * 2,
    meanRms,
    vocalActivity,
    confidence: 0.9,
  };
}

function analysis(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return {
    beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 240 },
    tempoConfidence: 0.9,
    energyCurve: [],
    drops: [],
    key: key("8B", 0),
    vocalRanges: [],
    loudness: 0.2,
    analysisVersion: 2,
    audioHash: "hash-a",
    ...overrides,
  };
}

function richRequest(): RecipeRequest {
  const outgoing = analysis({
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("verse", 16, 64, 0.3, 0.85),
      section("chorus", 64, 112, 0.5, 0.9),
      section("verse", 112, 200, 0.3, 0.85),
      section("outro", 200, 240, 0.1, 0),
    ],
    outro: { startSec: 200, endSec: 240, startBeat: 400, endBeat: 480 },
    vocalActivity: vocalCurve(240, (t) => (t < 16 ? 0 : t < 200 ? 0.9 : 0)),
  });
  const incoming = analysis({
    audioHash: "hash-b",
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("chorus", 16, 64, 0.5, 0.9),
      section("verse", 64, 160, 0.3, 0.85),
      section("chorus", 160, 240, 0.5, 0.9),
    ],
    intro: { startSec: 0, endSec: 16, startBeat: 0, endBeat: 32 },
    drops: [{ timeSec: 32, beat: 64, strength: 2.4 }],
    vocalActivity: vocalCurve(240, (t) => (t < 16 ? 0 : 0.9)),
  });
  return { outgoing, outgoingPositionSec: 60, incoming };
}

function join(overrides: Partial<JoinRecord> = {}): JoinRecord {
  return {
    aAudioHash: "other-a",
    bAudioHash: "other-b",
    family: "standard-blend",
    profileId: "standard",
    pairShape: "matched/same/both-vocal",
    blendBeats: 16,
    stretch: 0,
    heardLengthSec: 60,
    at: 1_000,
    ...overrides,
  };
}

function standardBlend(candidates: Candidate[]): Candidate {
  const found = candidates.find(
    (c) => c.family === "standard-blend" && c.profileId === "standard",
  );
  expect(found).toBeDefined();
  return found!;
}

describe("scoring — charter requirement 2: history moves the score", () => {
  it("Req 2 — the same pair with different join histories scores the repeated family measurably lower", () => {
    const candidates = candidatesForPair(richRequest());

    const fresh = scoreCandidates(candidates, {}, STANDARD_PROFILE);
    for (const scored of fresh.ranked) {
      // Anti-repetition is ONLY history-deep: no history, no charge,
      // for any candidate, however repetitive its family may look.
      expect(scored.historyCost).toBe(0);
    }

    const history: JoinRecord[] = [join(), join(), join()];
    const repeated = scoreCandidates(candidates, { history }, STANDARD_PROFILE);
    const freshBlend = fresh.ranked.find(
      (s) => s.candidate === standardBlend(candidates),
    )!;
    const repeatedBlend = repeated.ranked.find(
      (s) => s.candidate === standardBlend(candidates),
    )!;
    expect(repeatedBlend.historyCost).toBeGreaterThan(0.15);
    expect(repeatedBlend.historyNotes.length).toBeGreaterThan(0);
    // The whole score drop is the history charge — nothing else moved.
    expect(freshBlend.score - repeatedBlend.score).toBeCloseTo(
      repeatedBlend.historyCost,
      9,
    );
  });
});

describe("scoring — vetoes: never crown a guess", () => {
  it("a candidate authored under a wider cap is vetoed under a stricter profile", () => {
    const request = richRequest();
    request.incoming = analysis({
      ...request.incoming,
      beatMap: {
        bpm: 120 / 1.08,
        firstBeatSec: 0,
        beatsPerBar: 4,
        durationSec: 240,
      },
    });
    const candidates = candidatesForPair(request, {
      profiles: [ADVENTUROUS_PROFILE],
    });
    const beatmatched = candidates.find((c) => c.evidence.beatmatched);
    expect(beatmatched).toBeDefined();

    const result = scoreCandidates(candidates, {}, STANDARD_PROFILE);
    const scored = result.ranked.find((s) => s.candidate === beatmatched)!;
    expect(scored.vetoed).toBe(true);
    expect(scored.vetoReasons.join(" ")).toContain("stretch");
    expect(result.pick).not.toBeNull();
    expect(result.pick!.candidate.evidence.beatmatched).toBe(false);
  });

  it("scoring refuses to crown a candidate whose tempo evidence is a guess", () => {
    const candidates = candidatesForPair(richRequest());
    const blend = standardBlend(candidates);
    const guessed: Candidate = {
      ...blend,
      evidence: { ...blend.evidence, tempoConfidence: 0.1 },
    };
    const letItPlay = candidates.find((c) => c.family === "let-it-play")!;
    const result = scoreCandidates([guessed, letItPlay], {}, STANDARD_PROFILE);
    const scored = result.ranked.find((s) => s.candidate === guessed)!;
    expect(scored.vetoed).toBe(true);
    expect(scored.vetoReasons.join(" ")).toContain("beatmatch on a guess");
    expect(result.pick!.candidate).toBe(letItPlay);
  });

  it("a trusted vocal clash vetoes; the same overlap on uncertain evidence only discounts", () => {
    const candidates = candidatesForPair(richRequest());
    const blend = standardBlend(candidates);
    const trusted: Candidate = {
      ...blend,
      evidence: {
        ...blend.evidence,
        vocalOverlap: 0.9,
        vocalEvidence: "trusted",
      },
    };
    const uncertain: Candidate = {
      ...blend,
      evidence: {
        ...blend.evidence,
        vocalOverlap: 0.9,
        vocalEvidence: "uncertain",
      },
    };
    const trustedResult = scoreCandidates([trusted], {}, STANDARD_PROFILE);
    expect(trustedResult.ranked[0].vetoed).toBe(true);
    expect(trustedResult.pick).toBeNull();

    const uncertainResult = scoreCandidates([uncertain], {}, STANDARD_PROFILE);
    expect(uncertainResult.ranked[0].vetoed).toBe(false);
    const clarity = uncertainResult.ranked[0].components.find(
      (c) => c.name === "vocalClarity",
    )!;
    expect(clarity.value).toBeCloseTo(0.55, 9);
  });

  it("a distant key vetoes a long blend but not a capped one", () => {
    const candidates = candidatesForPair(richRequest());
    const blend = standardBlend(candidates);
    const longDistant: Candidate = {
      ...blend,
      evidence: { ...blend.evidence, keyRelation: "distant", blendBeats: 24 },
    };
    const cappedDistant: Candidate = {
      ...blend,
      evidence: { ...blend.evidence, keyRelation: "distant", blendBeats: 8 },
    };
    expect(
      scoreCandidates([longDistant], {}, STANDARD_PROFILE).ranked[0].vetoed,
    ).toBe(true);
    expect(
      scoreCandidates([cappedDistant], {}, STANDARD_PROFILE).ranked[0].vetoed,
    ).toBe(false);
  });
});

describe("scoring — the evidence trail", () => {
  it("the winner's components sum to its score and every one says why", () => {
    const result = scoreCandidates(
      candidatesForPair(richRequest()),
      {},
      STANDARD_PROFILE,
    );
    expect(result.pick).not.toBeNull();
    const pick = result.pick!;
    const sum = pick.components.reduce((s, c) => s + c.contribution, 0);
    expect(sum).toBeCloseTo(pick.score, 9);
    expect(pick.components.map((c) => c.name)).toEqual([
      "keyFit",
      "vocalClarity",
      "stretchFit",
      "structureFit",
      "loopValue",
      "arcFit",
      "familyCost",
      "history",
    ]);
    for (const component of pick.components) {
      expect(component.note.length).toBeGreaterThan(0);
    }
  });

  it("arc fit follows the session's energy target when one is supplied", () => {
    const candidates = candidatesForPair(richRequest());
    const blend = standardBlend(candidates);
    const placed: Candidate = {
      ...blend,
      evidence: { ...blend.evidence, entryEnergy: 0.2 },
    };
    const onTarget = scoreCandidates(
      [placed],
      { arcTargetEnergy: 0.2 },
      STANDARD_PROFILE,
    );
    expect(
      onTarget.ranked[0].components.find((c) => c.name === "arcFit")!.value,
    ).toBeCloseTo(1, 9);
    const offTarget = scoreCandidates(
      [placed],
      { arcTargetEnergy: 0.9 },
      STANDARD_PROFILE,
    );
    expect(
      offTarget.ranked[0].components.find((c) => c.name === "arcFit")!.value,
    ).toBeCloseTo(0.3, 9);
  });
});

describe("scoring — selection from the near-equal band", () => {
  it("within the band, history — not the raw score — picks the winner", () => {
    const candidates = candidatesForPair(richRequest());
    const blend = standardBlend(candidates);
    // Two rivals identical but for key fit and family. The echo-out
    // leads on evidence by a hair (inside the 0.05 band)…
    const leader: Candidate = {
      ...blend,
      family: "echo-out",
      evidence: { ...blend.evidence, keyScore: 1, keyRelation: "same" },
    };
    const fresher: Candidate = {
      ...blend,
      family: "filter-fade",
      evidence: { ...blend.evidence, keyScore: 0.45, keyRelation: "near" },
    };
    // …but echo-out was the last join performed, for this very shape.
    const history: JoinRecord[] = [
      join({ family: "echo-out", blendBeats: 0, heardLengthSec: null }),
    ];
    const result = scoreCandidates(
      [leader, fresher],
      { history },
      STANDARD_PROFILE,
    );
    expect(result.ranked[0].candidate).toBe(leader);
    expect(result.band).toHaveLength(2);
    expect(result.pick!.candidate).toBe(fresher);
    expect(result.pick!.historyCost).toBe(0);
  });
});
