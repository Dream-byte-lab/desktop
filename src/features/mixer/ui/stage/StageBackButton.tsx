import { ArrowLeftLine } from "@mingcute/react";
import { useDjModeStore } from "../../store/djModeStore";

// The stage's way back (Note 25): the Pro stage had no exit of
// its own — the only toggle lived outside it, in DjProView — so
// every visit trapped the user until they closed the app. This
// button closes the stage from inside it, in the house's back
// idiom (the StickyHeader / lyrics-view pattern: an ArrowLeftLine
// pill, labelled, keyboard-reachable). It is a VIEW act only: it
// writes the mode store's proOpen and nothing else — a running
// session keeps playing untouched, and reopening Pro returns to
// the live stage. DjStageView mounts it in both of its states
// (set active, and the not-active personality frame), because
// the trap existed in both.
//
// The label matches the existing locale key `common.back`
// ("Back"); the stage's surfaces are not localised yet (every
// label in DjStageView is a literal), so the string is a literal
// here too, named against that key in the seam report.

export function StageBackButton() {
  const setProOpen = useDjModeStore((state) => state.setProOpen);
  return (
    <button
      type="button"
      onClick={() => setProOpen(false)}
      aria-label="Back"
      data-no-window-drag
      className="group inline-flex h-[32px] shrink-0 cursor-pointer items-center gap-[6px] rounded-full border-0 bg-black/[0.05] px-[10px] text-[13px] font-medium text-text-primary select-none transition-all hover:bg-black/[0.09] active:scale-[0.94] dark:bg-white/[0.09] dark:hover:bg-white/[0.14]"
    >
      <ArrowLeftLine
        size={16}
        className="transition-transform duration-150 group-hover:-translate-x-0.5"
      />
      <span className="relative top-[1px] -left-[1.5px]">Back</span>
    </button>
  );
}
