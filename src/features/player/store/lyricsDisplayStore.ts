import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { LyricsDisplayOptions } from "@/features/lyrics";

/**
 * The lyrics view's accessibility preferences (reference 27):
 * surface-local controls on the full-screen lyrics view, mirrored in
 * Settings as the global defaults. One store is the single source
 * for both ends, so a change made in either place is the same fact.
 *
 * Defaults are reference 27's image composition for a user who has
 * never touched the controls: blur on, highlight on, centred text,
 * standard text size.
 */

export type LyricsTextAlign = "left" | "center";

/** Bigger text is one real scale step over the base typography. */
export const LYRICS_BIGGER_TEXT_SCALE = 1.3;

export interface LyricsDisplayState {
  /** The artwork atmosphere's Gaussian blur. Off = flat backdrop. */
  gaussianBlur: boolean;
  biggerText: boolean;
  highlightLyrics: boolean;
  textAlign: LyricsTextAlign;
  /**
   * Pronunciation sub-lines under lyric lines (source-provided or
   * computed, letter-faithful). Default OFF — the user's
   * romanization posture (name display ruling, 2026-11-03) applied
   * to the lyrics surface too. Translations are never gated by it.
   */
  romanization: boolean;
  setGaussianBlur: (enabled: boolean) => void;
  setBiggerText: (enabled: boolean) => void;
  setHighlightLyrics: (enabled: boolean) => void;
  setTextAlign: (align: LyricsTextAlign) => void;
  setRomanization: (enabled: boolean) => void;
}

export const useLyricsDisplayStore = create<LyricsDisplayState>()(
  persist(
    (set) => ({
      gaussianBlur: true,
      biggerText: false,
      highlightLyrics: true,
      textAlign: "center",
      romanization: false,
      setGaussianBlur: (gaussianBlur) => set({ gaussianBlur }),
      setBiggerText: (biggerText) => set({ biggerText }),
      setHighlightLyrics: (highlightLyrics) => set({ highlightLyrics }),
      setTextAlign: (textAlign) => set({ textAlign }),
      setRomanization: (romanization) => set({ romanization }),
    }),
    {
      name: "linerave_lyrics_display_v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        gaussianBlur: state.gaussianBlur,
        biggerText: state.biggerText,
        highlightLyrics: state.highlightLyrics,
        textAlign: state.textAlign,
        romanization: state.romanization,
      }),
    },
  ),
);

/** Maps the preferences onto the canvas renderer's display options. */
export function lyricsDisplayOptionsFor(state: {
  textAlign: LyricsTextAlign;
  highlightLyrics: boolean;
  biggerText: boolean;
  romanization?: boolean;
}): LyricsDisplayOptions {
  return {
    align: state.textAlign === "left" ? "start" : "center",
    highlight: state.highlightLyrics,
    textScale: state.biggerText ? LYRICS_BIGGER_TEXT_SCALE : 1,
    // Included only when the caller supplies the preference, so a
    // partial push (or an older caller) leaves the scene's current
    // romanization state untouched rather than forcing it off.
    ...(state.romanization === undefined
      ? {}
      : { romanization: state.romanization }),
  };
}
