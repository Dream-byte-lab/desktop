import { ArrowLeftLine } from "@mingcute/react";
import { useDjModeStore } from "../../store/djModeStore";

// The DJ stage's back button: a plain control with one plain
// job — leave the Pro stage and return to the view underneath
// it. It is a normal button with a normal click handler: the
// click writes the mode store's proOpen flag, the stage's
// ordinary exit, and nothing else. A running session keeps
// playing untouched, and reopening Pro returns to the live
// stage. The button mounts in both of the stage's states (set
// active, and the not-active personality frame), because the
// exit has to exist in both. Its hit area is deliberately
// generous, and it sits in the stage header's top-left, above
// the decks, where a back control is expected to be found.
export function LeaveStageButton() {
  const setProOpen = useDjModeStore((state) => state.setProOpen);
  return (
    <button
      type="button"
      onClick={() => setProOpen(false)}
      aria-label="Back"
      data-no-window-drag
      className="relative z-10 inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-full border-0 bg-black/[0.05] px-4 text-sm font-medium text-text-primary select-none transition-colors hover:bg-black/[0.09] active:scale-[0.97] dark:bg-white/[0.09] dark:hover:bg-white/[0.14]"
    >
      <ArrowLeftLine size={18} />
      <span>Back</span>
    </button>
  );
}
