import { create } from "zustand";

// Whether DJ mode is on. Kept in step with the session itself through
// its running-change notice, so the switch in the player bar always
// shows the truth — including when a session ends on its own.

interface DjModeState {
  active: boolean;
  /** True while a blend between two tracks is actually sounding. */
  blending: boolean;
  /** Whether the Pro controls panel is open. */
  proOpen: boolean;
  setActive: (active: boolean) => void;
  setBlending: (blending: boolean) => void;
  setProOpen: (proOpen: boolean) => void;
}

export const useDjModeStore = create<DjModeState>((set) => ({
  active: false,
  blending: false,
  proOpen: false,
  setActive: (active) => set({ active }),
  setBlending: (blending) => set({ blending }),
  setProOpen: (proOpen) => set({ proOpen }),
}));
