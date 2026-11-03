import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { AccentChoice } from "../lib/accent";

// The accent preference (Interface Build 6). Persisted like the
// other appearance stores (the playback-bar pin's idiom). The
// default is the icon sweep itself: choice "sweep", no custom
// colour — and the sync hook sets NO data-accent attribute for it,
// so an untouched install's styling is byte-identical to before.
// `customHex` remembers the user's own colour even while a curated
// family is selected, so the custom slot is still there when they
// come back to it.

interface AccentState {
  choice: AccentChoice;
  customHex: string | null;
  setChoice: (choice: AccentChoice) => void;
  setCustomHex: (hex: string | null) => void;
}

export const useAccentStore = create<AccentState>()(
  persist(
    (set) => ({
      choice: "sweep",
      customHex: null,
      setChoice: (choice) => set({ choice }),
      setCustomHex: (customHex) => set({ customHex }),
    }),
    {
      name: "linerave-accent",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        choice: state.choice,
        customHex: state.customHex,
      }),
    },
  ),
);
