import { create } from "zustand";

// Focus mode (Interface Build 6) — the DESIGN-READ annex proposal,
// adopted as written: "a deliberate, single-purpose listening
// state. Entered from Now Playing (or by shortcut), it reduces the
// app to the music… One gesture (Esc, or the doorway in reverse)
// returns everything exactly as it was."
//
// The annex implies no persisted preference — entering is a
// deliberate act each time, and nothing in the proposal asks the
// app to remember it — so this store is deliberately NOT
// persisted: a fresh launch always starts outside Focus.
interface FocusModeState {
  active: boolean;
  enter: () => void;
  exit: () => void;
  toggle: () => void;
}

export const useFocusModeStore = create<FocusModeState>()((set) => ({
  active: false,
  enter: () => set({ active: true }),
  exit: () => set({ active: false }),
  toggle: () => set((state) => ({ active: !state.active })),
}));
