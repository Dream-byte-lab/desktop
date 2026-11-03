import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { debouncedStorage } from "@/shared/utils/storage";

/**
 * Persisted on/off store for name romanization (display aid).
 *
 * Default OFF (user's ruling, 2026-11-03): romanization never replaces or
 * alters the original name — the original always renders primary and the
 * romanization is a subordinate extra line — but the aid stays off until
 * the user switches it on in the Library controls.
 *
 * Follows the codebase's zustand + persist + debouncedStorage idiom (same
 * shape as the Discord settings store).
 */
interface RomanizationState {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export const useRomanizationStore = create<RomanizationState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled: (enabled) => set({ enabled }),
    }),
    {
      name: "liner_romanization_v1",
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (state): { enabled: boolean } => ({
        enabled: state.enabled,
      }),
      onRehydrateStorage: () => (state) => {
        if (state && typeof state.enabled !== "boolean") {
          state.setEnabled(true);
        }
      },
    },
  ),
);

/** Non-hook read for places that cannot use a hook. */
export function isRomanizationEnabled(): boolean {
  return useRomanizationStore.getState().enabled;
}

/**
 * Romanize for display only when the toggle is on. This is the single gate
 * every display consumer goes through: when the toggle is off it returns
 * null everywhere, so no romanized output can appear.
 */
export function romanizeIfEnabled(
  text: string | null | undefined,
  romanizeFn: (text: string) => string | null,
): string | null {
  if (!text) return null;
  if (!isRomanizationEnabled()) return null;
  return romanizeFn(text);
}
