// PersonalityPanel.tsx — the shared personality + sliders surface
// for the new DJ interface (§10.3), built on liverave/settings.ts.
//
// Seven personality tiles (name, signature colour, one-line
// behaviour) and the eight contract sliders as lighting-desk
// strips, both wired straight to useDjSettings: choosing a tile or
// moving a strip re-shapes the live session through the settings
// store's shaping subscription (wiring.ts) — this component only
// writes settings, exactly like any other settings surface. It is
// shared: the Booth renders it in its performance column's orbit,
// and any other surviving mount can render the same panel.

import { useDjSettings } from "@/features/mixer/liverave/settings";
import { PERSONALITY_IDS } from "@/features/mixer/liverave/shaping";
import { PERSONALITIES, SLIDERS, sliderEffect } from "./sessionView";

export function PersonalityPanel() {
  const personalityId = useDjSettings((state) => state.personalityId);
  const sliders = useDjSettings((state) => state.sliders);
  const setPersonality = useDjSettings((state) => state.setPersonality);
  const setSlider = useDjSettings((state) => state.setSlider);

  return (
    <div data-testid="personality-panel" className="flex flex-col gap-5">
      <section aria-label="DJ personality">
        <h3 className="text-[11px] font-semibold tracking-[0.18em] text-white/50 uppercase">
          Personality
        </h3>
        <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-3">
          {PERSONALITY_IDS.map((id) => {
            const meta = PERSONALITIES.find((p) => p.id === id);
            if (!meta) return null;
            const selected = personalityId === id;
            return (
              <button
                key={id}
                type="button"
                data-personality-tile={id}
                aria-pressed={selected}
                onClick={() => setPersonality(id)}
                className="cursor-pointer rounded-xl border p-3 text-left transition-transform active:scale-[0.98]"
                style={{
                  borderColor: selected
                    ? meta.colour
                    : "rgba(255,255,255,0.10)",
                  background: selected
                    ? `linear-gradient(135deg, ${meta.colour}33, rgba(23,18,31,0.9))`
                    : "rgba(255,255,255,0.04)",
                  boxShadow: selected ? `0 0 18px ${meta.colour}55` : undefined,
                }}
              >
                <span
                  className="block text-sm font-bold tracking-wide"
                  style={{ color: selected ? meta.colour : "#f2f0f7" }}
                >
                  {meta.name}
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-white/60">
                  {meta.line}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-label="DJ sliders">
        <h3 className="text-[11px] font-semibold tracking-[0.18em] text-white/50 uppercase">
          Sliders
        </h3>
        <div className="mt-2 flex flex-col gap-3">
          {SLIDERS.map((meta) => {
            const value = sliders[meta.id] ?? 0.5;
            return (
              <label
                key={meta.id}
                className="block"
                data-slider-strip={meta.id}
              >
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-xs font-semibold text-white/85">
                    {meta.name}
                  </span>
                  <span
                    className="text-[11px] text-white/55"
                    data-slider-effect={meta.id}
                  >
                    {sliderEffect(meta, value)}
                  </span>
                </span>
                <span className="mt-0.5 block text-[11px] text-white/45">
                  {meta.caption}
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={value}
                  aria-label={meta.name}
                  onChange={(event) =>
                    setSlider(meta.id, Number(event.target.value))
                  }
                  className="mt-1 w-full accent-[#8b6cff]"
                />
              </label>
            );
          })}
        </div>
      </section>
    </div>
  );
}
