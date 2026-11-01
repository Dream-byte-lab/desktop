import { describe, expect, it } from "vitest";
import type { BeatMap } from "./beatMap";
import { planTransition, planTransitionWithReferee } from "./transitionPlanner";

function track(partial: Partial<BeatMap>): BeatMap {
  return {
    bpm: 128,
    firstBeatSec: 0,
    beatsPerBar: 4,
    durationSec: 300,
    ...partial,
  };
}

describe("planTransition", () => {
  it("starts the blend on a phrase boundary of the outgoing track", () => {
    const plan = planTransition({
      outgoing: track({}),
      outgoingPositionSec: 61.3,
      incoming: track({}),
      incomingEntryBeat: 32,
    });
    expect(plan).not.toBeNull();
    // 16-beat phrases at 128 bpm: boundaries fall on whole phrases
    expect(plan!.outgoingExitBeat % 16).toBe(0);
    // at 61.3s we are on beat ~130.7; the first boundary with at least
    // 8 beats of lead is beat 144
    expect(plan!.outgoingExitBeat).toBe(144);
    expect(plan!.blendBeats).toBe(16);
    expect(plan!.outgoingEndBeat).toBe(160);
  });

  it("lands the incoming entry beat exactly at the end of the blend", () => {
    const plan = planTransition({
      outgoing: track({}),
      outgoingPositionSec: 10,
      incoming: track({ firstBeatSec: 0.5 }),
      incomingEntryBeat: 32,
    });
    expect(plan).not.toBeNull();
    // 16 blend beats at the outgoing tempo (0.46875s each) before beat 32
    expect(plan!.incomingStartSec).toBeCloseTo(0.5 + 16 * 0.46875, 6);
    expect(plan!.blendDurationSec).toBeCloseTo(16 * 0.46875, 6);
  });

  it("tempo-matches the incoming track to the outgoing one", () => {
    const plan = planTransition({
      outgoing: track({ bpm: 126 }),
      outgoingPositionSec: 10,
      incoming: track({ bpm: 120 }),
      incomingEntryBeat: 32,
    });
    expect(plan).not.toBeNull();
    expect(plan!.incomingRate).toBeCloseTo(126 / 120, 6);
    expect(plan!.tempoStretch).toBeCloseTo(0.05, 6);
    expect(plan!.tempoComfortable).toBe(true);
  });

  it("measures the incoming start position in the incoming track's own time", () => {
    const plan = planTransition({
      outgoing: track({ bpm: 126 }),
      outgoingPositionSec: 10,
      incoming: track({ bpm: 120, firstBeatSec: 0.25 }),
      incomingEntryBeat: 32,
      blendBeats: 16,
    });
    expect(plan).not.toBeNull();
    // 16 beats before the entry beat, at the incoming track's own
    // 120 bpm (0.5s per beat): 0.25 + 16 * 0.5
    expect(plan!.incomingStartSec).toBeCloseTo(8.25, 6);
    // …while the blend itself lasts 16 beats at the outgoing 126 bpm
    expect(plan!.blendDurationSec).toBeCloseTo(16 * (60 / 126), 6);
  });

  it("reports the pair's key fit on the plan", () => {
    const plan = planTransition({
      outgoing: track({ bpm: 120 }),
      outgoingPositionSec: 10,
      incoming: track({ bpm: 120 }),
      incomingEntryBeat: 32,
      outgoingKey: {
        tonic: "C",
        mode: "major",
        pitchClass: 0,
        camelot: "8B",
        confidence: 0.9,
      },
      incomingKey: {
        tonic: "A",
        mode: "minor",
        pitchClass: 9,
        camelot: "8A",
        confidence: 0.9,
      },
    });
    expect(plan).not.toBeNull();
    expect(plan!.keyCompatibility?.relation).toBe("relative");
    expect(plan!.keyCompatibility?.compatible).toBe(true);
  });

  it("refuses a clashing pair only when key compatibility is required", () => {
    const clash = {
      outgoing: track({ bpm: 120 }),
      outgoingPositionSec: 10,
      incoming: track({ bpm: 120 }),
      incomingEntryBeat: 32,
      outgoingKey: {
        tonic: "C",
        mode: "major",
        pitchClass: 0,
        camelot: "8B",
        confidence: 0.9,
      } as const,
      incomingKey: {
        tonic: "F#",
        mode: "major",
        pitchClass: 6,
        camelot: "2B",
        confidence: 0.9,
      } as const,
    };
    expect(planTransition(clash)).not.toBeNull();
    expect(
      planTransition({ ...clash, requireKeyCompatibility: true }),
    ).toBeNull();
  });

  it("reports when both tracks would sing through the blend", () => {
    // At 120 bpm from 10s in, the blend runs 16s–24s of the outgoing
    // track and 8s–16s of the incoming one.
    const base = {
      outgoing: track({ bpm: 120 }),
      outgoingPositionSec: 10,
      incoming: track({ bpm: 120 }),
      incomingEntryBeat: 32,
    };
    const both = planTransition({
      ...base,
      outgoingVocals: [{ startSec: 15, endSec: 25 }],
      incomingVocals: [{ startSec: 10, endSec: 14 }],
    });
    expect(both?.vocalOverlap).toBe(true);

    const incomingQuiet = planTransition({
      ...base,
      outgoingVocals: [{ startSec: 15, endSec: 25 }],
      incomingVocals: [{ startSec: 30, endSec: 40 }],
    });
    expect(incomingQuiet?.vocalOverlap).toBe(false);

    const unknown = planTransition(base);
    expect(unknown?.vocalOverlap).toBe(false);
  });

  describe("planTransitionWithReferee", () => {
    // Same geometry as above: at 120 bpm from 10s in, a 16-beat blend
    // covers 16s–24s of the outgoing track and 8s–16s of the incoming.
    const base = {
      outgoing: track({ bpm: 120 }),
      outgoingPositionSec: 10,
      incoming: track({ bpm: 120 }),
      incomingEntryBeat: 32,
    };

    it("keeps the full blend when no voices collide", () => {
      const plan = planTransitionWithReferee({
        ...base,
        outgoingVocals: [{ startSec: 40, endSec: 50 }],
        incomingVocals: [{ startSec: 30, endSec: 40 }],
      });
      expect(plan?.blendBeats).toBe(16);
      expect(plan?.vocalOverlap).toBe(false);
    });

    it("shortens the blend to end before a late outgoing line", () => {
      // The outgoing singer's line at 22s–30s only clips the tail of
      // the 16-beat window (16s–24s); a 12-beat blend ends at 22s.
      const plan = planTransitionWithReferee({
        ...base,
        outgoingVocals: [{ startSec: 22, endSec: 30 }],
        incomingVocals: [{ startSec: 8, endSec: 20 }],
      });
      expect(plan).not.toBeNull();
      expect(plan!.vocalOverlap).toBe(false);
      expect(plan!.blendBeats).toBeLessThan(16);
    });

    it("refuses the blend when every length overlaps two voices", () => {
      const plan = planTransitionWithReferee({
        ...base,
        outgoingVocals: [{ startSec: 16, endSec: 40 }],
        incomingVocals: [{ startSec: 0, endSec: 40 }],
      });
      expect(plan).toBeNull();
    });

    it("still returns null when no blend exists at all", () => {
      const plan = planTransitionWithReferee({
        outgoing: track({ bpm: 120, durationSec: 12 }),
        outgoingPositionSec: 10,
        incoming: track({ bpm: 120 }),
        incomingEntryBeat: 32,
      });
      expect(plan).toBeNull();
    });
  });

  it("flags a stretch beyond the comfortable tolerance", () => {
    const plan = planTransition({
      outgoing: track({ bpm: 128 }),
      outgoingPositionSec: 10,
      incoming: track({ bpm: 100 }),
      incomingEntryBeat: 32,
    });
    expect(plan).not.toBeNull();
    expect(plan!.incomingRate).toBeCloseTo(1.28, 6);
    expect(plan!.tempoComfortable).toBe(false);
  });

  it("shortens the blend when the incoming track cannot start before zero", () => {
    const plan = planTransition({
      outgoing: track({}),
      outgoingPositionSec: 10,
      incoming: track({ firstBeatSec: 0 }),
      incomingEntryBeat: 8,
      blendBeats: 16,
    });
    expect(plan).not.toBeNull();
    // only 8 beats exist before the entry beat, so the blend shrinks to fit
    expect(plan!.blendBeats).toBe(8);
    expect(plan!.incomingStartSec).toBe(0);
  });

  it("swaps the bass on a bar boundary near the middle of the blend", () => {
    const plan = planTransition({
      outgoing: track({}),
      outgoingPositionSec: 10,
      incoming: track({}),
      incomingEntryBeat: 64,
      blendBeats: 32,
    });
    expect(plan).not.toBeNull();
    expect(plan!.bassSwapBeatOffset).toBe(16);
    expect(plan!.bassSwapInSec - plan!.startsInSec).toBeCloseTo(
      16 * 0.46875,
      6,
    );
  });

  it("refuses when the outgoing track has no room left for a blend", () => {
    const plan = planTransition({
      outgoing: track({ durationSec: 70 }),
      outgoingPositionSec: 69,
      incoming: track({}),
      incomingEntryBeat: 32,
    });
    expect(plan).toBeNull();
  });

  it("refuses when the entry beat is past the end of the incoming track", () => {
    const plan = planTransition({
      outgoing: track({}),
      outgoingPositionSec: 10,
      incoming: track({ durationSec: 20 }),
      incomingEntryBeat: 64,
    });
    expect(plan).toBeNull();
  });

  it("glides the incoming track back to its own tempo over one phrase", () => {
    const plan = planTransition({
      outgoing: track({ bpm: 126 }),
      outgoingPositionSec: 10,
      incoming: track({ bpm: 120 }),
      incomingEntryBeat: 32,
    });
    expect(plan).not.toBeNull();
    // one 16-beat phrase at the incoming track's own 120 bpm = 8 seconds
    expect(plan!.rateReturnDurationSec).toBeCloseTo(8, 6);
  });
});
