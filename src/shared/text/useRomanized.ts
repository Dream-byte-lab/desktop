import { useMemo } from "react";
import { romanize } from "./romanize";
import { useRomanizationStore } from "./romanizationStore";

/**
 * Display-only romanization for a name (track, artist, playlist, album).
 *
 * Returns the romanization to render as a secondary, subordinate line/span
 * beside the ORIGINAL name, or null when there is nothing honest to show or
 * the romanization toggle is off. The original string is the identity used
 * for search, matching and storage and is never changed by this hook — the
 * result exists only at render time.
 */
export function useRomanized(text: string | null | undefined): string | null {
  const enabled = useRomanizationStore((state) => state.enabled);
  return useMemo(() => {
    if (!enabled || !text) return null;
    return romanize(text);
  }, [enabled, text]);
}
