import { useState } from "react";
import { usePlayerStore } from "../../player/store/playerStore";
import { djSession } from "../engine/djSession";
import type { DeckIndex } from "../engine/twoDeckMixer";
import { preparedTrack } from "../engine/trackSource";
import { useDjModeStore } from "../store/djModeStore";

// The Pro layer: real hands-on controls over the same two decks the
// automatic session is playing — for someone who wants the DJ feel.
// Nothing here replaces the automation. The controls write to the
// mixer's manual stage (crossfader, per-deck trims, per-deck bass
// kill), which multiplies the automated gains instead of sharing
// them, so a hand can lean on a blend — favour a deck, ride a trim,
// kill a bassline — without ever corrupting the blend's scheduling.
//
// The panel also shows what a DJ would want to know at a glance: for
// each physical deck, the track on it, its tempo and its Camelot key.

interface DjProToggleProps {
  className?: string;
  activeClassName?: string;
}

export function DjProToggle({ className, activeClassName }: DjProToggleProps) {
  const active = useDjModeStore((state) => state.active);
  const proOpen = useDjModeStore((state) => state.proOpen);
  const setProOpen = useDjModeStore((state) => state.setProOpen);

  // Seamless-protection rule: the Pro layer must never clutter the
  // plain press-play experience. Until DJ mode is on, this control
  // does not exist in the interface at all.
  if (!active) return null;

  return (
    <button
      type="button"
      aria-label="Pro deck controls"
      aria-pressed={proOpen}
      title="Pro controls — crossfader, trims and bass kills for the two decks"
      className={`${className ?? ""} ${proOpen ? (activeClassName ?? "") : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={() => setProOpen(!proOpen)}
      style={{
        cursor: "pointer",
        width: "auto",
        padding: "0 8px",
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.08em",
      }}
    >
      PRO
    </button>
  );
}

function deckReadout(trackId: string | undefined) {
  if (!trackId) return null;
  const prepared = preparedTrack(trackId);
  if (!prepared) return null;
  const { bpm } = prepared.analysis.beatMap;
  const key = prepared.analysis.key;
  return `${bpm.toFixed(1)} BPM${key ? ` · ${key.camelot} (${key.tonic} ${key.mode})` : ""}`;
}

export function DjProView() {
  const active = useDjModeStore((state) => state.active);
  const proOpen = useDjModeStore((state) => state.proOpen);
  const currentTrack = usePlayerStore((state) => state.currentTrack);
  const nextTrack = usePlayerStore(
    (state) => state.queue[state.currentIndex + 1] ?? null,
  );

  const [crossfade, setCrossfadeState] = useState(0);
  const [trims, setTrims] = useState<[number, number]>([100, 100]);
  const [bassCut, setBassCut] = useState<[boolean, boolean]>([false, false]);

  if (!active || !proOpen) return null;

  const playingDeck = djSession.currentDeckIndex;
  const deckTrack = (index: DeckIndex) =>
    index === playingDeck ? currentTrack : nextTrack;
  const deckRole = (index: DeckIndex) =>
    index === playingDeck ? "Playing" : "Next up";

  const onCrossfade = (value: number) => {
    setCrossfadeState(value);
    djSession.setCrossfade(value / 50);
  };
  const onTrim = (index: DeckIndex, percent: number) => {
    const next: [number, number] = [...trims];
    next[index] = percent;
    setTrims(next);
    djSession.setDeckTrim(index, percent / 100);
  };
  const onBassCut = (index: DeckIndex) => {
    const next: [boolean, boolean] = [...bassCut];
    next[index] = !next[index];
    setBassCut(next);
    djSession.setDeckBassCut(index, next[index]);
  };

  return (
    <div className="w-full border-t border-border-tertiary bg-bg-primary px-3 py-2 text-text-primary">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-6">
        {([0, 1] as DeckIndex[]).map((index) => {
          const track = deckTrack(index);
          return (
            <div key={index} className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
                  Deck {index + 1} · {deckRole(index)}
                </span>
                <span className="text-[11px] tabular-nums text-text-secondary">
                  {deckReadout(track?.id)}
                </span>
              </div>
              <div className="truncate text-sm font-semibold">
                {track ? track.title : "—"}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <label className="text-[11px] text-text-secondary">Trim</label>
                <input
                  type="range"
                  min={0}
                  max={125}
                  value={trims[index]}
                  onChange={(e) => onTrim(index, Number(e.target.value))}
                  className="min-w-0 flex-1"
                  aria-label={`Deck ${index + 1} trim`}
                />
                <span className="w-10 text-right text-[11px] tabular-nums text-text-secondary">
                  {trims[index]}%
                </span>
                <button
                  type="button"
                  aria-pressed={bassCut[index]}
                  onClick={() => onBassCut(index)}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                    bassCut[index]
                      ? "bg-red-400/20 text-red-500"
                      : "bg-black/[0.05] dark:bg-white/[0.09] text-text-secondary"
                  }`}
                >
                  Bass {bassCut[index] ? "killed" : "on"}
                </button>
              </div>
            </div>
          );
        })}

        <div className="min-w-0 flex-1 lg:max-w-xs">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-secondary">
            Crossfader
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-[11px] font-semibold">1</span>
            <input
              type="range"
              min={-50}
              max={50}
              value={crossfade}
              onChange={(e) => onCrossfade(Number(e.target.value))}
              className="min-w-0 flex-1"
              aria-label="Crossfader"
            />
            <span className="text-[11px] font-semibold">2</span>
          </div>
          <div className="text-center text-[11px] text-text-secondary">
            {crossfade === 0
              ? "Centre — the automation is untouched"
              : crossfade < 0
                ? "Leaning to Deck 1"
                : "Leaning to Deck 2"}
          </div>
        </div>
      </div>
    </div>
  );
}
