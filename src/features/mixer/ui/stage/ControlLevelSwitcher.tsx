import type { DjControlLevel, StageControlIntents } from "./stageSnapshot";

// The control-level switcher (the engine seams): the spec's
// three levels as a real switch, bound to the snapshot's
// controlLevel and the session's setControlLevel through the
// intents. Before the seams this was a derived readout ("where
// hands have been"); now the level is the session's standing
// state and the switcher writes it. Renders nothing when the
// wiring provides no level intent (the pre-seam surfaces and
// fixtures), exactly as StageSnapshotControls renders nothing
// without a snapshot.

const LEVELS: { level: DjControlLevel; label: string }[] = [
  { level: "autonomous", label: "Fully autonomous" },
  { level: "assisted", label: "Assisted" },
  { level: "manual", label: "Manual" },
];

const LEVEL_NOTES: Record<DjControlLevel, string> = {
  autonomous: "The DJ authors and performs every join.",
  assisted:
    "The DJ performs — and whatever your hands grab (EQ, filter, FX sends) stays yours through the next joins.",
  manual:
    "The brain stops authoring. Your hands rule the decks; the set still never goes silent underneath you.",
};

interface ControlLevelSwitcherProps {
  level: DjControlLevel;
  intents: StageControlIntents;
}

export function ControlLevelSwitcher({
  level,
  intents,
}: ControlLevelSwitcherProps) {
  if (!intents.onControlLevel) return null;
  const onControlLevel = intents.onControlLevel;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] font-semibold tracking-wide text-text-secondary uppercase">
        Control
      </span>
      <div className="inline-flex overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.09]">
        {LEVELS.map(({ level: candidate, label }) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={level === candidate}
            onClick={() => onControlLevel(candidate)}
            className={`cursor-pointer px-2.5 py-1 text-[11px] font-semibold ${
              level === candidate
                ? "bg-black/[0.12] text-text-primary dark:bg-white/[0.18]"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <span className="text-[11px] text-text-secondary">
        {LEVEL_NOTES[level]}
      </span>
    </div>
  );
}
