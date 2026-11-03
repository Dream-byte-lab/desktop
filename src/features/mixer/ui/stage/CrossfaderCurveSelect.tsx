import type {
  StageControlIntents,
  StageCrossfaderCurve,
} from "./stageSnapshot";

// The crossfader curve choice: three named shapes, the active one
// pressed. Pure render — the choice leaves as an intent and the
// snapshot's curve is what comes back.

interface CrossfaderCurveSelectProps {
  curve: StageCrossfaderCurve;
  intents: StageControlIntents;
}

const CURVE_OPTIONS: readonly {
  label: string;
  value: StageCrossfaderCurve;
}[] = [
  { label: "Smooth", value: "smooth" },
  { label: "Constant power", value: "constant-power" },
  { label: "Cut", value: "cut" },
];

export function CrossfaderCurveSelect({
  curve,
  intents,
}: CrossfaderCurveSelectProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        Crossfader curve
      </span>
      {CURVE_OPTIONS.map((option) => {
        const active = curve === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => intents.onCrossfaderCurveChange(option.value)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              active
                ? "bg-black/[0.12] text-text-primary dark:bg-white/[0.16]"
                : "bg-black/[0.05] text-text-secondary dark:bg-white/[0.09]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
