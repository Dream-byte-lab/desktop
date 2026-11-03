// The Now Playing morph — shared constants for the signature
// transition between the playback pill and the Now Playing card
// (design read: the standard → full morph; reference 30's motion
// table gives the Now Playing transition token as 300–450 ms).
//
// The pill's artwork and the card's artwork carry the same
// framer-motion `layoutId`, so one element travels between the two
// surfaces instead of a page swap. Everything the morph animates is
// transform/opacity (plus the artwork's border radius, which framer
// interpolates as part of the shared-element projection) — no layout
// properties are animated by the morph itself. Reduced motion (the
// framer `useReducedMotion` channel, which follows the OS
// preference) removes the shared element entirely: both artworks
// then mount plainly and the surfaces crossfade, per the read's
// reduced-motion supremacy rule.

export const NOW_PLAYING_ARTWORK_LAYOUT_ID = "now-playing-artwork";

/** 380 ms — inside the read's 300–450 ms Now Playing band. */
export const NOW_PLAYING_MORPH_DURATION_S = 0.38;

/** The app's established ease (globals.css `--motion-ease`). */
export const NOW_PLAYING_MORPH_EASE = [0.22, 1, 0.36, 1] as const;

export const NOW_PLAYING_MORPH_TRANSITION = {
  duration: NOW_PLAYING_MORPH_DURATION_S,
  ease: NOW_PLAYING_MORPH_EASE,
} as const;
