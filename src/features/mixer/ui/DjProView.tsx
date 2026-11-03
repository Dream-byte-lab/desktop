import { DjStageView } from "./stage/DjStageView";
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
//
// The strip this file used to render has been succeeded by the DJ
// stage (stage/DjStageView.tsx): a battle layout with jog wheels,
// waveforms, cue pads and channel faders over the same seams. This
// file keeps the two exports the shell imports — DjProToggle for
// the player bar and DjProView for the frame — and delegates the
// panel itself to the stage.

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
        // No width/padding overrides: like the DJ button beside it,
        // this toggle accepts the player bar's shared 30px icon-button
        // class so the toolbox geometry budget holds with DJ on
        // (Step 2, slice C).
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.08em",
      }}
    >
      PRO
    </button>
  );
}

export function DjProView() {
  return <DjStageView />;
}
