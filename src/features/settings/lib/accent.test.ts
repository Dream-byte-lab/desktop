import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACCENT_FAMILIES,
  ACCENT_GUARD_MIN_RATIO,
  accentContrastFloor,
  accentFamily,
  accentPassesGuard,
  contrastRatio,
  customAccentCss,
  guardCustomAccent,
  hexToHsl,
  hslToHex,
  normalizeHex,
} from "./accent";

// The accent system (Interface Build 6). The pins that matter:
// the shipped default passes its own guard in both modes (an
// untouched install is untouched), every curated family passes,
// and a custom pick always lands on readable per-mode shades.

describe("colour math", () => {
  it("contrastRatio is the WCAG ratio (black/white = 21, symmetric)", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 1);
    expect(contrastRatio("#3fd68f", "#3fd68f")).toBeCloseTo(1, 5);
  });

  it("hex <-> hsl round-trips the sweep stops", () => {
    for (const hex of ["#8fe63e", "#3fd68f", "#2fd6a3", "#149a6c"]) {
      const hsl = hexToHsl(hex);
      expect(hsl).not.toBeNull();
      expect(hslToHex(hsl!)).toBe(hex);
    }
    expect(hexToHsl("not-a-colour")).toBeNull();
    expect(normalizeHex("#3FD68F")).toBe("#3fd68f");
    expect(normalizeHex("nope")).toBeNull();
  });
});

describe("the guard vs the curated family", () => {
  it("the shipped sweep passes the guard in both modes (default parity)", () => {
    const sweep = accentFamily("sweep");
    expect(accentPassesGuard(sweep.dark.spring, "dark")).toBe(true);
    expect(accentPassesGuard(sweep.light.spring, "light")).toBe(true);
    // The measured floors, pinned so a token change re-opens the
    // question instead of silently weakening the default.
    expect(accentContrastFloor(sweep.dark.spring, "dark")).toBeGreaterThan(8);
    expect(accentContrastFloor(sweep.light.spring, "light")).toBeGreaterThan(
      ACCENT_GUARD_MIN_RATIO,
    );
    expect(accentContrastFloor(sweep.light.spring, "light")).toBeLessThan(4.5);
  });

  it("every curated family passes the guard in both modes", () => {
    for (const family of ACCENT_FAMILIES) {
      expect(
        accentPassesGuard(family.dark.spring, "dark"),
        `${family.id} dark`,
      ).toBe(true);
      expect(
        accentPassesGuard(family.light.spring, "light"),
        `${family.id} light`,
      ).toBe(true);
    }
  });

  it("every curated family except the inherited sweep clears 4.5 in both modes", () => {
    for (const family of ACCENT_FAMILIES) {
      if (family.id === "sweep") continue;
      expect(
        accentContrastFloor(family.dark.spring, "dark"),
        `${family.id} dark`,
      ).toBeGreaterThan(4.5);
      expect(
        accentContrastFloor(family.light.spring, "light"),
        `${family.id} light`,
      ).toBeGreaterThan(4.5);
    }
  });

  it("the TS mirror matches the token layer in globals.css", () => {
    const css = readFileSync(
      join(process.cwd(), "src/app/globals.css"),
      "utf8",
    ).toLowerCase();
    for (const family of ACCENT_FAMILIES) {
      if (family.id === "sweep") {
        // The default has no block of its own — that absence IS the
        // parity guarantee, so pin it.
        expect(css).not.toContain('data-accent="sweep"');
        continue;
      }
      expect(css).toContain(`data-accent="${family.id}"`);
      expect(css).toContain(family.dark.spring);
      expect(css).toContain(family.light.spring);
      expect(css).toContain(family.dark.lime);
      expect(css).toContain(family.light.teal);
    }
  });
});

describe("guardCustomAccent", () => {
  it("a pick that already reads in both modes is applied unadjusted", () => {
    const guarded = guardCustomAccent("#149a6c");
    expect(guarded).not.toBeNull();
    expect(guarded!.adjusted).toBe(false);
    expect(guarded!.dark.spring).toBe("#149a6c");
    expect(guarded!.light.spring).toBe("#149a6c");
  });

  it("a pale pick is darkened for light mode and stays readable in both", () => {
    const guarded = guardCustomAccent("#fde68a");
    expect(guarded).not.toBeNull();
    expect(guarded!.adjusted).toBe(true);
    expect(accentPassesGuard(guarded!.dark.spring, "dark")).toBe(true);
    expect(accentPassesGuard(guarded!.light.spring, "light")).toBe(true);
    // The light shade is the nearest passing one: one step back
    // toward the pick fails again.
    const lightHsl = hexToHsl(guarded!.light.spring)!;
    const oneStepBack = hslToHex({ ...lightHsl, l: lightHsl.l + 0.5 });
    expect(accentPassesGuard(oneStepBack, "light")).toBe(false);
  });

  it("a deep pick is lightened for dark mode", () => {
    const guarded = guardCustomAccent("#172554");
    expect(guarded).not.toBeNull();
    expect(guarded!.adjusted).toBe(true);
    expect(accentPassesGuard(guarded!.dark.spring, "dark")).toBe(true);
    expect(accentPassesGuard(guarded!.light.spring, "light")).toBe(true);
    const darkHsl = hexToHsl(guarded!.dark.spring)!;
    const pickHsl = hexToHsl("#172554")!;
    expect(darkHsl.l).toBeGreaterThan(pickHsl.l);
    expect(Math.abs(darkHsl.h - pickHsl.h)).toBeLessThan(1);
  });

  it("white and black picks land on readable shades", () => {
    const white = guardCustomAccent("#ffffff");
    expect(white).not.toBeNull();
    expect(accentPassesGuard(white!.dark.spring, "dark")).toBe(true);
    expect(accentPassesGuard(white!.light.spring, "light")).toBe(true);

    const black = guardCustomAccent("#000000");
    expect(black).not.toBeNull();
    expect(black!.light.spring).toBe("#000000");
    expect(accentPassesGuard(black!.dark.spring, "dark")).toBe(true);
  });

  it("derived stops follow the sweep profile around the spring", () => {
    const guarded = guardCustomAccent("#149a6c")!;
    const spring = hexToHsl(guarded.dark.spring)!;
    const lime = hexToHsl(guarded.dark.lime)!;
    const teal = hexToHsl(guarded.dark.teal)!;
    expect(lime.h).toBeCloseTo(spring.h - 34, 0);
    expect(teal.h).toBeCloseTo(spring.h + 15, 0);
    expect(lime.l).toBeGreaterThan(spring.l);
    expect(teal.l).toBeLessThan(spring.l);
  });

  it("an unparseable colour is refused, not applied", () => {
    expect(guardCustomAccent("chartreuse-ish")).toBeNull();
    expect(guardCustomAccent("#12345")).toBeNull();
  });

  it("customAccentCss carries the guarded springs in the custom rules", () => {
    const guarded = guardCustomAccent("#fde68a")!;
    const css = customAccentCss(guarded);
    expect(css).toContain('data-accent="custom"');
    expect(css).toContain(`--sweep-spring: ${guarded.dark.spring}`);
    expect(css).toContain(`--sweep-spring: ${guarded.light.spring}`);
    expect(css).toContain("--accent-primary:");
    expect(css).toContain("--btn-primary-bg:");
  });
});
