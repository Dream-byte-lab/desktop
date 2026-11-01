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
//   - echo-out:  no blend and no drop to land on, but the outgoing
//                track is still alive at its end — dissolve it into
//                a beat-synced echo that rings over the next track's
//                start instead of stopping dead;
//   - cut:       the outgoing track already ends quietly (a fade, a
//                soft tail) — a clean cut respects that ending.
//
// The decisions are driven by the analysis (the code-level "ears")
// today; metadata and context (arc position, taste) are further
// inputs the same decider can weigh as those sources land.

export type TransitionDecision =
  | { kind: "blend"; plan: TransitionPlan }
  | { kind: "drop-cut"; entrySec: number }
  | { kind: "echo-out" }
  | { kind: "cut" };

const MIN_DROP_BEAT = 8;
/** Below this mean tail energy, a track is treated as ending quietly. */
const QUIET_TAIL = 0.08;

/** Mean energy of the outgoing track's last two seconds (0 if unknown). */
function tailEnergy(analysis: TrackAnalysis): number | null {
  const curve = analysis.energyCurve;
  if (curve.length === 0) return null;
  const tail = curve.slice(-2);
  return tail.reduce((sum, point) => sum + point.energy, 0) / tail.length;
}

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

  const tail = tailEnergy(input.outgoing);
  if (tail === null || tail >= QUIET_TAIL) return { kind: "echo-out" };
  return { kind: "cut" };
}
