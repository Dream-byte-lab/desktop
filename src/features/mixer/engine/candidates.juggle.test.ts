import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import type { TrackAnalysis, TrackSection } from "./analyseTrack";
import { DjBrain } from "./brain";
import { authorJuggle, authorManualJuggle } from "./candidates";
import {
  ADVENTUROUS_PROFILE,
  CONSERVATIVE_PROFILE,
  STANDARD_PROFILE,
} from "./decisionProfile";
import type { KeyEstimate } from "./detectKey";
import type { VocalActivityCurve } from "./detectVocals";
import { createJoinHistory, type JoinLogStorage } from "./joinHistory";
import { decisionSeed } from "./selection";
import type { PreparedTrack } from "./trackSource";

// The juggle's author and admission spend (the crab-and-juggling
// plan, steps 6–8). The author mirrors the scratch family's
// discipline — price gate, witnessed low-vocal material,
// transient riches, a real landing, runway — on ONE track; the
// spend is the [juggle, restraint] band: restraint wins most
// bands on its score, a performed juggle bends the next spend's
// odds through §15 without ever zeroing them, and §28 abstains
// on the record (no evaluation key, ever).
//
// Fixture arithmetic: 120 BPM, a beat is 0.5 s, a 240 s track is
// 480 beats.

function key(camelot: string, pitchClass: number): KeyEstimate {
  return { tonic: "C", mode: "major", pitchClass, camelot, confidence: 0.9 };
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

/** A graded vocal curve, one point every half second. */
function vocalCurve(
  activity: (sec: number) => number,
  confidence = 0.9,
): VocalActivityCurve {
  const points = [];
  for (let t = 0; t < 240; t += 0.5) {
    points.push({ timeSec: t, activity: activity(t), confidence });
  }
  return { windowSec: 0.25, stepSec: 0.5, points };
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

/**
 * A track with a break at 32 s (beat 64): a drop of strength 2.4
 * and a chorus starting there, over witnessed silence. The
 * segment's own end (beat 66) closes nothing, so the pattern the
 * material dictates is CONTINUE unless a second drop closes the
 * unit at beat 66 (the repeat fixture).
 */
function breakTrack(overrides: Partial<TrackAnalysis> = {}): TrackAnalysis {
  return analysis({
    drops: [{ timeSec: 32, beat: 64, strength: 2.4 }],
    sections: [
      section("intro", 0, 16, 0.15, 0),
      section("verse", 16, 32, 0.3, 0),
      section("chorus", 32, 64, 0.5, 0),
      section("verse", 64, 240, 0.3, 0),
    ],
    vocalActivity: vocalCurve(() => 0),
    ...overrides,
  });
}

describe("authorJuggle — the break, gated like scratch material", () => {
  it("authors a CONTINUE walk from a drop landing over witnessed, silent, stabbing material", () => {
    const authored = authorJuggle(breakTrack(), STANDARD_PROFILE, 26);
    expect(authored).not.toBeNull();
    const p = authored!.performance;
    expect(p.pattern).toBe("continue");
    expect(p.breakStartSec).toBe(32);
    expect(p.segments.map((s) => s.startSec)).toEqual([32, 33, 34]);
    expect(p.segments.map((s) => s.deck)).toEqual([0, 1, 0]);
    expect(p.exitSec).toBe(35);
    // The evidence, in scoring's arithmetic: the track against
    // itself is a perfect key fit; witnessed silence is full
    // clarity; rate 1 spends no stretch.
    expect(authored!.evidence.keyFit).toBe(1);
    expect(authored!.evidence.vocalClarity).toBe(1);
    expect(authored!.evidence.stretchFit).toBe(1);
    expect(authored!.evidence.loopValue).toBe(0.5);
    expect(authored!.evidence.entryEnergy).toBe(1);
    // structureFit: entry on a drop of 2.4 (0.95), exit on a bare
    // beat (0.4) — the mean of the two tables' reads.
    expect(authored!.evidence.structureFit).toBeCloseTo(0.675, 9);
  });

  it("authors a REPEAT when the segment's end closes the unit", () => {
    const track = breakTrack({
      drops: [
        { timeSec: 32, beat: 64, strength: 2.4 },
        { timeSec: 33, beat: 66, strength: 2 },
      ],
    });
    const authored = authorJuggle(track, STANDARD_PROFILE, 26);
    expect(authored).not.toBeNull();
    expect(authored!.performance.pattern).toBe("repeat");
    expect(authored!.performance.segments.map((s) => s.startSec)).toEqual([
      32, 32, 32,
    ]);
    expect(authored!.performance.exitSec).toBe(33);
  });

  it("a bold profile walks four segments; the standard walks three", () => {
    const authored = authorJuggle(breakTrack(), ADVENTUROUS_PROFILE, 26);
    expect(authored).not.toBeNull();
    expect(authored!.performance.segments).toHaveLength(4);
    expect(authored!.performance.exitSec).toBe(36);
  });

  it("the price gate: CONSERVATIVE authors nothing autonomously, and the host's hand is exempt", () => {
    expect(authorJuggle(breakTrack(), CONSERVATIVE_PROFILE, 26)).toBeNull();
    const manual = authorManualJuggle(breakTrack(), CONSERVATIVE_PROFILE, 26);
    expect(manual).not.toBeNull();
    expect(manual!.performance.breakStartSec).toBe(32);
  });

  it("a voice over the break refuses it — a break is instrumental material", () => {
    const track = breakTrack({
      vocalActivity: vocalCurve((t) => (t >= 32 && t < 36 ? 0.9 : 0)),
    });
    expect(authorJuggle(track, STANDARD_PROFILE, 26)).toBeNull();
    expect(authorManualJuggle(track, STANDARD_PROFILE, 26)).toBeNull();
  });

  it("unwitnessed material refuses: a quiet curve nobody vouches for is not evidence", () => {
    const track = breakTrack({
      vocalActivity: vocalCurve(() => 0, 0.1),
    });
    expect(authorJuggle(track, STANDARD_PROFILE, 26)).toBeNull();
  });

  it("a landing with nothing to chop refuses: no drop at the edge, no stabbing contour", () => {
    const track = breakTrack({ drops: [] });
    expect(authorJuggle(track, STANDARD_PROFILE, 26)).toBeNull();
  });

  it("the runway refuses: the act must leave the profile's minimum lead after the exit", () => {
    const short = breakTrack({
      beatMap: { bpm: 120, firstBeatSec: 0, beatsPerBar: 4, durationSec: 36 },
    });
    // The continue's exit (35 s) plus 8 beats of lead (4 s) runs
    // past the 36 s track.
    expect(authorJuggle(short, STANDARD_PROFILE, 26)).toBeNull();
  });

  it("a refused landing is passed over for the next landing inside the horizon", () => {
    const track = breakTrack({
      drops: [
        { timeSec: 32, beat: 64, strength: 2.4 },
        { timeSec: 36, beat: 72, strength: 2.4 },
      ],
      sections: [
        section("intro", 0, 16, 0.15, 0),
        section("verse", 16, 32, 0.3, 0),
        section("chorus", 32, 36, 0.5, 0.9),
        section("chorus", 36, 64, 0.5, 0),
        section("verse", 64, 240, 0.3, 0),
      ],
      // The first break's span is sung over; the second is silent.
      vocalActivity: vocalCurve((t) => (t >= 32 && t < 35 ? 0.9 : 0)),
    });
    const authored = authorJuggle(track, STANDARD_PROFILE, 27);
    expect(authored).not.toBeNull();
    expect(authored!.performance.breakStartSec).toBe(36);
  });

  it("no landing inside the horizon, no juggle — a later window's business", () => {
    expect(authorJuggle(breakTrack(), STANDARD_PROFILE, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// The admission spend
// ---------------------------------------------------------------------

function fakeJoinStorage(): JoinLogStorage {
  return { read: async () => null, write: async () => {} };
}

function prepared(analysisValue: TrackAnalysis): PreparedTrack {
  return {
    track: { id: "track-1" } as unknown as Track,
    buffer: { duration: 240 } as unknown as AudioBuffer,
    analysis: analysisValue,
    mixable: true,
  };
}

function newBrain(): DjBrain {
  return new DjBrain({
    history: createJoinHistory(fakeJoinStorage()),
    now: () => 1_000_000,
  });
}

const spendInput = (overrides = {}) => ({
  current: prepared(breakTrack()),
  positionSec: 26,
  arcPosition: 0.5,
  partyRequestsPending: false,
  ...overrides,
});

describe("brain.considerJuggle — the [juggle, restraint] spend", () => {
  it("spends a two-entry band through R5's lottery and audits it in selectFromBand's shape", () => {
    const brain = newBrain();
    const spend = brain.considerJuggle(spendInput());
    expect(spend).not.toBeNull();
    const record = spend!.selection;
    expect(record.method).toBe("softmax");
    // The first decision coordinate of the default seed's stream.
    expect(record.seed).toBe(decisionSeed("linerave", 0, 1));
    expect(record.band.map((b) => b.family)).toEqual(["juggle", "let-it-play"]);
    // Restraint stood IN the lottery — nothing was held out.
    expect(record.restraintHeld).toEqual([]);
    const [juggle, restraint] = record.band;
    expect(juggle.probability + restraint.probability).toBeCloseTo(1, 9);
    expect(juggle.probability).toBeGreaterThan(0);
    expect(juggle.probability).toBeLessThan(1);
    // On this evidence under STANDARD, restraint wins most bands
    // by construction: its score stands above the juggle's.
    expect(juggle.score).toBeLessThan(restraint.score);
    expect(restraint.score).toBeCloseTo(0.47, 9);
    expect(spend!.outcome).toBe(
      record.chosenIndex === 0 ? "juggle" : "restraint",
    );
    expect(record.agreedWithScorer).toBe(
      (record.chosenIndex === 0) === juggle.score >= restraint.score,
    );
  });

  it("one spend per window: the same break never re-rolls, until a new play re-arms it", () => {
    const brain = newBrain();
    expect(brain.considerJuggle(spendInput())).not.toBeNull();
    // A second consideration while the same break stands ahead:
    // no spend, no draw.
    expect(brain.considerJuggle(spendInput({ positionSec: 28 }))).toBeNull();
    brain.resetJuggleWindow();
    const again = brain.considerJuggle(spendInput());
    expect(again).not.toBeNull();
    // The re-armed spend drew the NEXT coordinate of the stream.
    expect(again!.selection.seed).toBe(decisionSeed("linerave", 0, 2));
  });

  it("the party ruling binds before authoring — and does not consume the window", () => {
    const brain = newBrain();
    expect(
      brain.considerJuggle(spendInput({ partyRequestsPending: true })),
    ).toBeNull();
    // The requests clear while the break still stands: the spend
    // may still happen, at the stream's first coordinate.
    const spend = brain.considerJuggle(spendInput());
    expect(spend).not.toBeNull();
    expect(spend!.selection.seed).toBe(decisionSeed("linerave", 0, 1));
  });

  it("§15: performed juggles bend the next spend's odds — and never to zero", () => {
    const brain = newBrain();
    const first = brain.considerJuggle(spendInput());
    expect(first).not.toBeNull();
    const freshProbability = first!.selection.band[0].probability;
    const current = prepared(breakTrack());
    for (let i = 0; i < 3; i += 1) {
      brain.recordPerformedJuggle({
        current,
        performance: first!.authored.performance,
        profile: STANDARD_PROFILE,
      });
    }
    brain.resetJuggleWindow();
    const second = brain.considerJuggle(spendInput());
    expect(second).not.toBeNull();
    const bent = second!.selection.band[0];
    expect(bent.recentUses).toBeGreaterThan(0);
    expect(bent.historyCost).toBeGreaterThan(0);
    expect(bent.probability).toBeLessThan(freshProbability);
    expect(bent.probability).toBeGreaterThan(0);
  });

  it("recordPerformedJuggle writes the self-pair record, and §28 abstains on it", () => {
    const brain = newBrain();
    const current = prepared(breakTrack());
    const authored = authorJuggle(breakTrack(), STANDARD_PROFILE, 26);
    expect(authored).not.toBeNull();
    brain.recordPerformedJuggle({
      current,
      performance: authored!.performance,
      profile: STANDARD_PROFILE,
    });
    const history = brain.historySnapshot();
    expect(history).toHaveLength(1);
    const record = history[0];
    expect(record.family).toBe("juggle");
    expect(record.aAudioHash).toBe("hash-a");
    expect(record.bAudioHash).toBe("hash-a");
    expect(record.blendBeats).toBe(6);
    expect(record.heardLengthSec).toBe(3);
    expect(record.stretch).toBe(0);
    // No outcome was reported, so no evaluation exists — the
    // record counts at exactly weight 1 in §15's weighting.
    expect("evaluation" in record).toBe(false);
  });
});
