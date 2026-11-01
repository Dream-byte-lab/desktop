import { create } from "zustand";

// Whether DJ mode is on. Kept in step with the session itself through
// its running-change notice, so the switch in the player bar always
// shows the truth — including when a session ends on its own.

interface DjModeState {
  active: boolean;
  /** True while a blend between two tracks is actually sounding. */
  blending: boolean;
  setActive: (active: boolean) => void;
  setBlending: (blending: boolean) => void;
}

export const useDjModeStore = create<DjModeState>((set) => ({
  active: false,
  blending: false,
  setActive: (active) => set({ active }),
  setBlending: (blending) => set({ blending }),
}));
