import { Fader } from "./Fader";
import {
  STAGE_EFFECT_KINDS,
  STAGE_EFFECT_LABELS,
  type StageControlIntents,
  type StageDeckSide,
  type StageEffectSnapshot,
  type StageFxAssign,
} from "./stageSnapshot";

// The FX monitor bank: one row per R3 effect, in R3 order. A row
// only ever shows what the snapshot proves — a network that has
// never been built says "Not built" and carries no wet fader, and
// a send level the snapshot cannot read gets no decorative control
// either. Assign and wet changes leave as intents.

interface FxBankProps {
  effects: StageEffectSnapshot[];
  intents: StageControlIntents;
}

const SIDES: readonly StageDeckSide[] = ["A", "B"];

const ASSIGN_OPTIONS: readonly {
  label: string;
  value: StageFxAssign;
}[] = [
  { label: "A", value: "A" },
  { label: "Both", value: "both" },
  { label: "B", value: "B" },
  { label: "Off", value: null },
];

function percentOrDash(level: number | null): string {
  return level === null ? "—" : `${Math.round(level * 100)}%`;
}

export function FxBank({ effects, intents }: FxBankProps) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
        Effects
      </span>
      {STAGE_EFFECT_KINDS.map((kind) => {
        const effect: StageEffectSnapshot = effects.find(
          (entry) => entry.kind === kind,
        ) ?? {
          kind,
          built: false,
          wetLevel: null,
          sendLevels: { A: null, B: null },
          assign: null,
        };
        return (
          <div
            key={kind}
            data-testid={`fx-row-${kind}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border-primary px-2 py-1.5"
          >
            <span className="min-w-20 text-[11px] font-semibold text-text-primary">
              {STAGE_EFFECT_LABELS[kind]}
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-text-secondary">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{
                  background: effect.built
                    ? "var(--accent-primary)"
                    : "rgba(148,140,190,0.6)",
                }}
                aria-hidden="true"
              />
              {effect.built ? "Built" : "Not built"}
            </span>
            <span className="text-[11px] tabular-nums text-text-secondary">
              {effect.wetLevel === null
                ? "Wet —"
                : `Wet ${Math.round(effect.wetLevel * 100)}%`}
            </span>
            <span className="text-[11px] tabular-nums text-text-secondary">
              {`A ${percentOrDash(effect.sendLevels.A)} · B ${percentOrDash(effect.sendLevels.B)}`}
            </span>
            <span className="flex items-center gap-1">
              {ASSIGN_OPTIONS.map((option) => {
                const active = effect.assign === option.value;
                return (
                  <button
                    key={option.label}
                    type="button"
                    aria-pressed={active}
                    onClick={() => intents.onFxAssign(kind, option.value)}
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
            </span>
            {SIDES.map((side) => {
              const level = effect.sendLevels[side];
              if (!effect.built || level === null) return null;
              return (
                <div key={side} className="min-w-36 flex-1">
                  <Fader
                    orientation="horizontal"
                    label={`${side} wet`}
                    value={level * 100}
                    min={0}
                    max={100}
                    onChange={(v) => intents.onFxWetLevel(kind, side, v / 100)}
                    formatValue={(v) => `${Math.round(v)}%`}
                  />
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
