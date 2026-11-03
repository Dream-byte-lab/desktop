import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

// The playback pill's two sizes (design read: "The playback region —
// the pill"). The user can pin a preferred size from Settings >
// Appearance > Playback bar appearance; that control is a later
// part's surface — this store is its seam. `null` means unpinned:
// the pill then expands contextually on hover, focus-within, or
// while one of its popups is open (see `resolveBarExpanded`).

export type PlayerBarPinnedSize = "standard" | "expanded";

interface PlayerBarSizeState {
  pinned: PlayerBarPinnedSize | null;
  setPinned: (pinned: PlayerBarPinnedSize | null) => void;
}

export const usePlayerBarSizeStore = create<PlayerBarSizeState>()(
  persist(
    (set) => ({
      pinned: null,
      setPinned: (pinned) => set({ pinned }),
    }),
    {
      name: "linerave-player-bar",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ pinned: state.pinned }),
    },
  ),
);

export interface ResolveBarExpandedInput {
  pinned: PlayerBarPinnedSize | null;
  hovered: boolean;
  focusWithin: boolean;
  popupOpen: boolean;
}

/**
 * Pure size resolution for the pill. A pinned size wins outright;
 * unpinned, the pill is expanded while any contextual signal holds.
 */
export function resolveBarExpanded(input: ResolveBarExpandedInput): boolean {
  if (input.pinned === "expanded") return true;
  if (input.pinned === "standard") return false;
  return input.hovered || input.focusWithin || input.popupOpen;
}
