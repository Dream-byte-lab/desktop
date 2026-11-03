import { ChannelStrip } from "./ChannelStrip";
import { CrossfaderCurveSelect } from "./CrossfaderCurveSelect";
import { FxBank } from "./FxBank";
import { StageMeters } from "./LevelMeter";
import type { StageControlIntents, StageSnapshot } from "./stageSnapshot";

// The single mount point for the stage's snapshot-driven half.
// With no snapshot there is nothing honest to show, so this renders
// nothing at all and the stage stays exactly Build 1; the future
// wiring slice mounts this with a real snapshot and the controls
// appear, driven purely by that data and the intents.

interface StageSnapshotControlsProps {
  snapshot: StageSnapshot | null | undefined;
  trims: [number, number];
  intents: StageControlIntents;
}

export function StageSnapshotControls({
  snapshot,
  trims,
  intents,
}: StageSnapshotControlsProps) {
  if (snapshot === null || snapshot === undefined) return null;

  return (
    <div className="rounded-lg border border-border-primary p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ChannelStrip
          deck={0}
          snapshot={snapshot.decks[0]}
          trim={trims[0]}
          intents={intents}
        />
        <StageMeters snapshot={snapshot} />
        <ChannelStrip
          deck={1}
          snapshot={snapshot.decks[1]}
          trim={trims[1]}
          intents={intents}
        />
      </div>
      <div className="mt-3">
        <FxBank effects={snapshot.effects} intents={intents} />
      </div>
      <div className="mt-3">
        <CrossfaderCurveSelect
          curve={snapshot.crossfaderCurve}
          intents={intents}
        />
      </div>
    </div>
  );
}
