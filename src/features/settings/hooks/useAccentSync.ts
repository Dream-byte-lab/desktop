import { useEffect } from "react";
import { useAccentStore } from "../store/accentStore";
import { customAccentCss, guardCustomAccent } from "../lib/accent";

const CUSTOM_STYLE_ID = "linerave-accent-custom";

/**
 * Applies the accent preference to the document (Interface Build 6).
 *
 * - "sweep" (the default): no data-accent attribute, no style
 *   element — the theme blocks in globals.css stand alone, exactly
 *   as before this build.
 * - A curated family: data-accent="<id>" on the root element; the
 *   family's block in globals.css does the rest.
 * - "custom": data-accent="custom" plus one managed <style> element
 *   carrying the guarded per-mode values in the same rule shapes
 *   (see lib/accent.ts). A stored custom colour that fails the
 *   guard outright applies nothing (the default stands) — the
 *   picker refuses such colours at pick time; this is the backstop
 *   for a value stored by any other path.
 */
export function useAccentSync() {
  const choice = useAccentStore((state) => state.choice);
  const customHex = useAccentStore((state) => state.customHex);

  useEffect(() => {
    const root = document.documentElement;
    let style = document.getElementById(
      CUSTOM_STYLE_ID,
    ) as HTMLStyleElement | null;

    if (choice === "sweep") {
      root.removeAttribute("data-accent");
      style?.remove();
      return;
    }

    if (choice === "custom") {
      const guarded = customHex ? guardCustomAccent(customHex) : null;
      if (!guarded) {
        root.removeAttribute("data-accent");
        style?.remove();
        return;
      }
      if (!style) {
        style = document.createElement("style");
        style.id = CUSTOM_STYLE_ID;
        document.head.appendChild(style);
      }
      style.textContent = customAccentCss(guarded);
      root.setAttribute("data-accent", "custom");
      return;
    }

    style?.remove();
    root.setAttribute("data-accent", choice);
  }, [choice, customHex]);
}
