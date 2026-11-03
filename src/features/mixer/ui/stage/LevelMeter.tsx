import {
  meterFraction,
  type StageMeterSummary,
  type StageSnapshot,
} from "./stageSnapshot";

// Level meters as data: the snapshot carries peak/RMS summaries
// from analyser taps the session owns; the stage only draws them.
// A null summary is the honest R3-lazy state — no tap exists yet —
// and renders as an empty, outlined meter saying so, never as a
// silent or fake-live bar.

interface LevelMeterProps {
  label: string;
  meter: StageMeterSummary | null;
}

export function LevelMeter({ label, meter }: LevelMeterProps) {
  const rmsFraction = meter ? meterFraction(meter.rms) : 0;
  const peakFraction = meter ? meterFraction(meter.peak) : 0;
  const hot = rmsFraction > 0.9;

  return (
    <div
      data-testid={`meter-${label}`}
      className="flex flex-col items-center gap-1"
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        {label}
      </span>
      <div className="relative h-28 w-3 overflow-hidden rounded border border-border-tertiary bg-black/[0.06] dark:bg-white/[0.08]">
        {meter ? (
          <>
            <div
              className={`absolute bottom-0 left-0 right-0 ${hot ? "bg-red-400" : ""}`}
              style={{
                height: `${rmsFraction * 100}%`,
                ...(hot ? {} : { background: "var(--accent-primary)" }),
              }}
              aria-hidden="true"
            />
            <div
              className="absolute left-0 right-0 h-[2px] bg-text-primary"
              style={{ bottom: `calc(${peakFraction * 100}% - 1px)` }}
              aria-hidden="true"
            />
          </>
        ) : null}
      </div>
      {meter ? (
        <span className="text-[11px] tabular-nums text-text-secondary">
          {`${Math.round(rmsFraction * 100)}%`}
        </span>
      ) : (
        <span className="text-[10px] text-text-secondary">No meter path</span>
      )}
    </div>
  );
}

export function StageMeters({ snapshot }: { snapshot: StageSnapshot }) {
  return (
    <div className="flex items-start justify-center gap-3">
      <LevelMeter label="Deck A" meter={snapshot.decks[0].meter} />
      <LevelMeter label="Deck B" meter={snapshot.decks[1].meter} />
      <LevelMeter label="Master" meter={snapshot.master.meter} />
    </div>
  );
}
