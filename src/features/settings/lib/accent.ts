// The accent system (Interface Build 6; design read, Open Question 2 —
// RULED 2026-11-03: a curated family plus one custom slot with an
// automatic contrast guard).
//
// The token layer of record is src/app/globals.css: the default sweep
// lives in its theme blocks, and each curated family below has a
// matching [data-accent="<id>"] block there restating the accent-role
// variables (the three sweep stops; --accent-primary/-secondary/
// -tertiary and --btn-primary-bg mirror them; --accent-gradient is
// built from the stops, so it follows). This module is the mirror the
// code side needs — the picker's swatches, the guard, and the custom
// slot's runtime values — and accent.test.ts pins the two together
// (every family's spring appears in globals.css under its block).
//
// The guard: an accent must stay readable in BOTH modes. Per mode it
// checks the primary stop (the sweep's spring position — the stop
// that carries links, active labels, toggle-on states and the
// primary button) against that mode's field and panel surfaces, and
// the mode's button text against the stop itself. The bar is 3:1,
// the WCAG non-text/component contrast bar — the accent's roles are
// component roles, and it is the bar the shipped sweep itself clears
// in both modes (measured: 8.27 dark, 3.37 light). Every curated
// family below clears 4.5:1 in both modes with room to spare.
//
// A custom pick that fails a mode is walked in lightness — up in
// dark mode, down in light mode, hue and saturation untouched — to
// the NEAREST shade that passes ("nearest passing shade", per the
// ruling). The two modes get their own shades of the pick, exactly
// like the shipped sweep has a dark and a light value. The gradient's
// other two stops are derived from each mode's guarded spring with
// the sweep's own profile (start stop rotated back in hue and a
// step lighter; end stop rotated forward and a step deeper).

export type AccentFamilyId = "sweep" | "lagoon" | "violet" | "ember" | "rose";
export type AccentChoice = AccentFamilyId | "custom";
export type AccentMode = "dark" | "light";

export interface AccentStops {
  lime: string;
  spring: string;
  teal: string;
}

/** The curated family, in picker order. "sweep" is the default — it
 * has no [data-accent] block; its stops are the theme blocks' own. */
export const ACCENT_FAMILIES: readonly {
  id: AccentFamilyId;
  dark: AccentStops;
  light: AccentStops;
}[] = [
  {
    id: "sweep",
    dark: { lime: "#8fe63e", spring: "#3fd68f", teal: "#2fd6a3" },
    light: { lime: "#5fa82e", spring: "#149a6c", teal: "#0e9494" },
  },
  {
    id: "lagoon",
    dark: { lime: "#22d3ee", spring: "#38bdf8", teal: "#60a5fa" },
    light: { lime: "#0891b2", spring: "#0369a1", teal: "#1d4ed8" },
  },
  {
    id: "violet",
    dark: { lime: "#818cf8", spring: "#a78bfa", teal: "#e879f9" },
    light: { lime: "#4f46e5", spring: "#6d28d9", teal: "#a21caf" },
  },
  {
    id: "ember",
    dark: { lime: "#fcd34d", spring: "#fb923c", teal: "#ef4444" },
    light: { lime: "#d97706", spring: "#c2410c", teal: "#b91c1c" },
  },
  {
    id: "rose",
    dark: { lime: "#f9a8d4", spring: "#fb7185", teal: "#d946ef" },
    light: { lime: "#db2777", spring: "#be123c", teal: "#a21caf" },
  },
];

export function accentFamily(id: AccentFamilyId) {
  return (
    ACCENT_FAMILIES.find((family) => family.id === id) ?? ACCENT_FAMILIES[0]
  );
}

/** The surfaces the guard reads against, per mode — the token values
 * from globals.css (--bg-primary field, --bg-panel, --btn-primary-text). */
export const ACCENT_SURFACES: Record<
  AccentMode,
  { field: string; panel: string; onAccent: string }
> = {
  dark: { field: "#1b1440", panel: "#251b52", onAccent: "#1b1440" },
  light: { field: "#faf8f3", panel: "#ffffff", onAccent: "#ffffff" },
};

/** The contrast bar the guard enforces (see the header note). */
export const ACCENT_GUARD_MIN_RATIO = 3;

// ------------------------------------------------------------ colour math

export interface Hsl {
  h: number; // 0..360
  s: number; // 0..100
  l: number; // 0..100
}

export function hexToHsl(hex: string): Hsl | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  const r = ((value >> 16) & 255) / 255;
  const g = ((value >> 8) & 255) / 255;
  const b = (value & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToHex({ h, s, l }: Hsl): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const lig = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  let rgb: [number, number, number];
  if (hue < 60) rgb = [c, x, 0];
  else if (hue < 120) rgb = [x, c, 0];
  else if (hue < 180) rgb = [0, c, x];
  else if (hue < 240) rgb = [0, x, c];
  else if (hue < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const channel = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

export function normalizeHex(hex: string): string | null {
  const hsl = hexToHsl(hex);
  return hsl ? hslToHex(hsl) : null;
}

function relativeLuminance(hex: string): number {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return 0;
  const value = parseInt(match[1], 16);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  );
}

/** WCAG contrast ratio between two hex colours (1..21, symmetric). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The guard's verdict for one primary stop in one mode: the lowest
 * of the three ratios that must all clear the bar. */
export function accentContrastFloor(hex: string, mode: AccentMode): number {
  const surfaces = ACCENT_SURFACES[mode];
  return Math.min(
    contrastRatio(hex, surfaces.field),
    contrastRatio(hex, surfaces.panel),
    contrastRatio(surfaces.onAccent, hex),
  );
}

export function accentPassesGuard(hex: string, mode: AccentMode): boolean {
  return accentContrastFloor(hex, mode) >= ACCENT_GUARD_MIN_RATIO;
}

// ---------------------------------------------------------------- the guard

export interface GuardedAccent {
  dark: AccentStops;
  light: AccentStops;
  /** True when either mode's spring differs from the picked colour. */
  adjusted: boolean;
}

/**
 * Walk one mode's spring from the pick to the nearest passing shade.
 * Dark mode walks lightness up, light mode walks it down; the walk
 * is in 0.5-point steps over the full lightness range, so the
 * result is the nearest shade the step grid holds. Returns null
 * when no shade at the pick's hue and saturation passes at all
 * (the picker then refuses the colour, honestly).
 */
function guardSpringForMode(pick: Hsl, mode: AccentMode): string | null {
  const direction = mode === "dark" ? 1 : -1;
  let l = pick.l;
  for (let step = 0; step <= 200; step++) {
    const candidate = hslToHex({ h: pick.h, s: pick.s, l });
    if (accentPassesGuard(candidate, mode)) return candidate;
    const next = l + direction * 0.5;
    if (next < 0 || next > 100) break;
    l = next;
  }
  return null;
}

/** Derive the gradient's other two stops from a mode's spring, on
 * the shipped sweep's profile (start: hue −34°, a step lighter;
 * end: hue +15°, a step deeper). */
function stopsFromSpring(springHex: string): AccentStops {
  const spring = hexToHsl(springHex);
  if (!spring) return { lime: springHex, spring: springHex, teal: springHex };
  return {
    lime: hslToHex({
      h: spring.h - 34,
      s: spring.s,
      l: Math.min(92, spring.l + 5),
    }),
    spring: springHex,
    teal: hslToHex({
      h: spring.h + 15,
      s: spring.s,
      l: Math.max(6, spring.l - 3),
    }),
  };
}

/**
 * Guard a custom pick for both modes. Returns the per-mode stops to
 * apply, or null when the colour cannot be made readable in some
 * mode (the picker refuses it with a note rather than applying it).
 */
export function guardCustomAccent(pickedHex: string): GuardedAccent | null {
  const pick = hexToHsl(pickedHex);
  if (!pick) return null;
  const darkSpring = guardSpringForMode(pick, "dark");
  const lightSpring = guardSpringForMode(pick, "light");
  if (!darkSpring || !lightSpring) return null;
  const normalized = hslToHex(pick);
  return {
    dark: stopsFromSpring(darkSpring),
    light: stopsFromSpring(lightSpring),
    adjusted: darkSpring !== normalized || lightSpring !== normalized,
  };
}

// ------------------------------------------------------- runtime CSS (custom)

/** The accent-role declarations for one set of stops. */
function accentDeclarations(stops: AccentStops): string {
  return [
    `--sweep-lime: ${stops.lime};`,
    `--sweep-spring: ${stops.spring};`,
    `--sweep-teal: ${stops.teal};`,
    `--accent-primary: ${stops.spring};`,
    `--accent-secondary: ${stops.teal};`,
    `--accent-tertiary: ${stops.lime};`,
    `--btn-primary-bg: ${stops.spring};`,
  ].join(" ");
}

/**
 * The custom slot's stylesheet text: the same four rule shapes the
 * curated families use in globals.css (light base, explicit dark,
 * OS-dark, forced-dark islands), carrying the guarded values.
 */
export function customAccentCss(guarded: GuardedAccent): string {
  const light = accentDeclarations(guarded.light);
  const dark = accentDeclarations(guarded.dark);
  return [
    `:root[data-accent="custom"] { ${light} }`,
    `:root[data-theme="dark"][data-accent="custom"], :root.dark[data-accent="custom"], :root[data-accent="custom"] [data-theme="dark"], :root[data-accent="custom"] .dark { ${dark} }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]):not(.light)[data-accent="custom"] { ${dark} } }`,
  ].join("\n");
}
