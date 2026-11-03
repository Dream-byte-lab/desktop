import {
  PERSONALITIES,
  PERSONALITY_IDS,
  SLIDER_IDS,
  type SliderId,
} from "../../engine/personality";
import {
  activeSlidersOf,
  usePersonalityStore,
} from "../../store/personalityStore";
import { Fader } from "./Fader";

// The personality panel (revamp slice R4): which DJ temperament is
// standing, and how its eight sliders have been bent. Personalities
// are decisions only, so the panel looks the same for all of them —
// no per-personality colours or theming. It reads and writes the
// personality store and nothing else; the wiring module is what
// applies the store to the session.

const SLIDER_LABELS: Record<SliderId, string> = {
  intensity: "Intensity",
  creativity: "Creativity",
  scratching: "Scratching",
  effects: "Effects",
  "transition-complexity": "Transition complexity",
  "genre-flexibility": "Genre flexibility",
  "energy-progression": "Energy progression",
  "track-selection-freedom": "Track-selection freedom",
};

export function PersonalityPanel() {
  const personalityId = usePersonalityStore((state) => state.personalityId);
  const slidersByPersonality = usePersonalityStore(
    (state) => state.slidersByPersonality,
  );
  const setPersonality = usePersonalityStore((state) => state.setPersonality);
  const setSlider = usePersonalityStore((state) => state.setSlider);
  const resetSliders = usePersonalityStore((state) => state.resetSliders);

  const sliders = activeSlidersOf({ personalityId, slidersByPersonality });
  const hasBentSlider = SLIDER_IDS.some((id) => sliders[id] !== 0.5);

  return (
    <div className="rounded-lg border border-border-primary p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
          Personality
        </span>
        {PERSONALITY_IDS.map((id) => {
          const active = id === personalityId;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => setPersonality(id)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                active
                  ? "bg-black/[0.12] text-text-primary dark:bg-white/[0.16]"
                  : "bg-black/[0.05] text-text-secondary dark:bg-white/[0.09]"
              }`}
            >
              {PERSONALITIES[id].label}
            </button>
          );
        })}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {SLIDER_IDS.map((id) => (
          <Fader
            key={id}
            orientation="horizontal"
            label={SLIDER_LABELS[id]}
            value={sliders[id] * 100}
            min={0}
            max={100}
            onChange={(v) => setSlider(id, v / 100)}
            formatValue={(v) => `${Math.round(v)}%`}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-text-tertiary">
          Each personality remembers its own slider bends.
        </span>
        {hasBentSlider ? (
          <button
            type="button"
            onClick={() => resetSliders()}
            className="rounded-full bg-black/[0.05] px-2.5 py-1 text-[11px] font-semibold text-text-secondary dark:bg-white/[0.09]"
          >
            Reset sliders
          </button>
        ) : null}
      </div>
    </div>
  );
}
