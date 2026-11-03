import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface SidebarState {
  collapsed: boolean;
  toggle: () => void;
  setCollapsed: (collapsed: boolean) => void;
}

function defaultCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.innerWidth < 1024;
}

export const useSidebarStore = create<SidebarState>()(
  persist(
    (set) => ({
      collapsed: defaultCollapsed(),
      toggle: () => set((state) => ({ collapsed: !state.collapsed })),
      setCollapsed: (collapsed) => set({ collapsed }),
    }),
    {
      name: "linerave-sidebar",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ collapsed: state.collapsed }),
    },
  ),
);
