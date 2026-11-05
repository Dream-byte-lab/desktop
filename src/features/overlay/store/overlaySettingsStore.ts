import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  OverlayPosition,
  OverlaySettings,
  OverlaySize,
} from "../contracts";
import { normalizeShortcutToEnglish } from "../lib/shortcutUtils";
import { clampOverlaySize, OVERLAY_SIZE_PRESETS } from "../lib/overlaySize";

interface OverlaySettingsState extends OverlaySettings {
  setEnabled: (enabled: boolean) => void;
  setPosition: (position: OverlayPosition) => void;
  setShortcut: (shortcut: string) => void;
  setAutoShowOnMinimize: (autoShowOnMinimize: boolean) => void;
  setAlwaysOnTop: (alwaysOnTop: boolean) => void;
  setSize: (size: OverlaySize) => void;
  /** Mirrors a size electron already applied and persisted (corner-grip
   *  drags): updates the store without echoing it back to electron. */
  hydrateSize: (size: OverlaySize) => void;
}

const DEFAULT_SETTINGS: OverlaySettings = {
  enabled: true,
  position: "top-center",
  shortcut: "Alt+Shift+O",
  autoShowOnMinimize: true,
  alwaysOnTop: true,
  size: { ...OVERLAY_SIZE_PRESETS.default },
};

function notifyElectron(patch: Partial<OverlaySettings>) {
  if (
    typeof window !== "undefined" &&
    window.linerElectron?.updateOverlaySettings
  ) {
    window.linerElectron.updateOverlaySettings(patch);
  }
}

export const useOverlaySettingsStore = create<OverlaySettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      setEnabled: (enabled) => {
        set({ enabled });
        notifyElectron({ enabled });
      },
      setPosition: (position) => {
        set({ position });
        notifyElectron({ position });
      },
      setShortcut: (rawShortcut) => {
        const shortcut =
          normalizeShortcutToEnglish(rawShortcut) || DEFAULT_SETTINGS.shortcut;
        set({ shortcut });
        notifyElectron({ shortcut });
      },
      setAutoShowOnMinimize: (autoShowOnMinimize) => {
        set({ autoShowOnMinimize });
        notifyElectron({ autoShowOnMinimize });
      },
      setAlwaysOnTop: (alwaysOnTop) => {
        set({ alwaysOnTop });
        notifyElectron({ alwaysOnTop });
      },
      setSize: (size) => {
        const clamped = clampOverlaySize(size);
        set({ size: clamped });
        notifyElectron({ size: clamped });
      },
      hydrateSize: (size) => {
        set({ size: clampOverlaySize(size) });
      },
    }),
    {
      name: "liner_overlay_settings_v1",
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => {
        if (state?.shortcut) {
          state.shortcut =
            normalizeShortcutToEnglish(state.shortcut) ||
            DEFAULT_SETTINGS.shortcut;
        }
      },
    },
  ),
);
