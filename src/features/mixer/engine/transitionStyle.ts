import type { TrackAnalysis } from "./analyseTrack";
import { timeAtBeat } from "./beatMap";
import { chooseEntryBeat } from "./entryBeat";
import {
  planTransitionWithReferee,
  type TransitionPlan,
} from "./transitionPlanner";

// Dynamic transition style: there is no single formula for joining
// two songs, and a real DJ doesn't apply one. The right join depends
// on the pair in front of you — their tempos, keys, vocals, and what
// the incoming track has to offer. This decider reads the two tracks'
// measured facts and chooses, per pair, per moment:
//
//   - blend:     a beatmatched, phrase-aligned blend (the referee's
//                plan), when an honest one exists;
//   - drop-cut:  no blend is honest, but the incoming track has a
//                real drop — cut straight into that drop as the
//                outgoing track ends, so the energy lands instead of
//                the join sagging (the classic drop swap);
//   - cut:       nothing better is available — a clean cut at the
//                outgoing track's end.
//
// The decisions are driven by the analysis (the code-level "ears")
// today; metadata and context (arc position, taste) are further
// inputs the same decider can weigh as those sources land.

export type TransitionDecision =
  | { kind: "blend"; plan: TransitionPlan }
  | { kind: "drop-cut"; entrySec: number }
  | { kind: "cut" };

const MIN_DROP_BEAT = 8;

export function decideTransition(input: {
  outgoing: TrackAnalysis;
  outgoingPositionSec: number;
  incoming: TrackAnalysis;
}): TransitionDecision {
  const entryBeat = chooseEntryBeat(input.incoming);
  const plan = planTransitionWithReferee({
    outgoing: input.outgoing.beatMap,
    outgoingPositionSec: input.outgoingPositionSec,
    incoming: input.incoming.beatMap,
    incomingEntryBeat: entryBeat,
    outgoingKey: input.outgoing.key,
    incomingKey: input.incoming.key,
    outgoingVocals: input.outgoing.vocalRanges,
    incomingVocals: input.incoming.vocalRanges,
  });
  if (plan) return { kind: "blend", plan };

  const hasUsableDrop = input.incoming.drops.some(
    (drop) => drop.beat >= MIN_DROP_BEAT,
  );
  if (hasUsableDrop && entryBeat > 0) {
    return {
      kind: "drop-cut",
      entrySec: timeAtBeat(input.incoming.beatMap, entryBeat),
    };
  }
  return { kind: "cut" };
}
