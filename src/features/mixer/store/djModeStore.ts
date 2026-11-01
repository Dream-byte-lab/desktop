import { create } from "zustand";

// Whether DJ mode is on. Kept in step with the session itself through
// its running-change notice, so the switch in the player bar always
// shows the truth — including when a session ends on its own.

interface DjModeState {
  active: boolean;
  setActive: (active: boolean) => void;
}

export const useDjModeStore = create<DjModeState>((set) => ({
  active: false,
  setActive: (active) => set({ active }),
}));
