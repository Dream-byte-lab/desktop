import { Fader } from "./Fader";
import { Knob } from "./Knob";
import {
  STAGE_EQ_MAX_DB,
  STAGE_EQ_MIN_DB,
  STAGE_FILTER_MAX_HZ,
  STAGE_FILTER_MIN_HZ,
  sideForDeck,
  type StageControlIntents,
  type StageDeckIndex,
  type StageDeckSnapshot,
} from "./stageSnapshot";

// One REV7 channel strip, in the machine's order: trim fader, the
// three EQ knobs, then the filter. Pure render over the snapshot —
// every value is the deck's true state as the snapshot carries it,
// and every grab leaves as an intent. The filter knob is driven in
// log space (Knob is linear) so a sweep feels even across the
// 60 Hz – 20 kHz domain.

interface ChannelStripProps {
  deck: StageDeckIndex;
  snapshot: StageDeckSnapshot;
  /** Trim as a ratio, 1 = unity (the manual stage's own value). */
  trim: number;
  intents: StageControlIntents;
}

function formatHz(logHz: number): string {
  const hz = Math.exp(logHz);
  if (hz >= 1000) {
    const khz = hz / 1000;
    const rounded = Math.round(khz * 10) / 10;
    return `${Number.isInteger(rounded) ? Math.round(rounded) : rounded} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

export function ChannelStrip({
  deck,
  snapshot,
  trim,
  intents,
}: ChannelStripProps) {
  const side = sideForDeck(deck);
  const filterHz = Math.min(
    STAGE_FILTER_MAX_HZ,
    Math.max(STAGE_FILTER_MIN_HZ, snapshot.filterHz),
  );

  return (
    <div
      data-testid={`channel-strip-${side}`}
      className="flex flex-col items-center gap-2"
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        Deck {side}
      </span>
      <Fader
        orientation="vertical"
        label="Trim"
        value={trim * 100}
        min={0}
        max={125}
        onChange={(v) => intents.onTrimChange(deck, v / 100)}
        formatValue={(v) => `${Math.round(v)}%`}
      />
      <Knob
        label="Bass"
        value={snapshot.bassDb}
        min={STAGE_EQ_MIN_DB}
        max={STAGE_EQ_MAX_DB}
        detentValue={0}
        onChange={(v) => intents.onEqChange(deck, "bass", v)}
        formatValue={(v) => `${Math.round(v)} dB`}
      />
      <Knob
        label="Mid"
        value={snapshot.midDb}
        min={STAGE_EQ_MIN_DB}
        max={STAGE_EQ_MAX_DB}
        detentValue={0}
        onChange={(v) => intents.onEqChange(deck, "mid", v)}
        formatValue={(v) => `${Math.round(v)} dB`}
      />
      <Knob
        label="High"
        value={snapshot.highDb}
        min={STAGE_EQ_MIN_DB}
        max={STAGE_EQ_MAX_DB}
        detentValue={0}
        onChange={(v) => intents.onEqChange(deck, "high", v)}
        formatValue={(v) => `${Math.round(v)} dB`}
      />
      <Knob
        label="Filter"
        value={Math.log(filterHz)}
        min={Math.log(STAGE_FILTER_MIN_HZ)}
        max={Math.log(STAGE_FILTER_MAX_HZ)}
        onChange={(v) => intents.onFilterChange(deck, Math.exp(v))}
        formatValue={formatHz}
      />
    </div>
  );
}
