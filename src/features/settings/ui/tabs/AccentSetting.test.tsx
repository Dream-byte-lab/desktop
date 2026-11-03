import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/languages", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  getTranslationsForAllLocales: (key: string) => [key],
}));

import { AccentSetting } from "./AccentSetting";
import { useAccentStore } from "../../store/accentStore";

// The mocked translation returns each key as its own text, so
// controls are found by their locale keys (the PlaybackBarSetting
// test's idiom).

describe("AccentSetting — the accent picker", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useAccentStore.setState({ choice: "sweep", customHex: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = () => {
    act(() => {
      root.render(<AccentSetting />);
    });
  };

  const familyButton = (id: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === `settings.accent.families.${id}`,
    ) as HTMLButtonElement;

  it("renders the five families with the sweep pressed by default", () => {
    render();
    for (const id of ["sweep", "lagoon", "violet", "ember", "rose"]) {
      expect(familyButton(id), id).toBeDefined();
    }
    expect(familyButton("sweep").getAttribute("aria-pressed")).toBe("true");
    expect(familyButton("lagoon").getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('input[type="color"]')).not.toBeNull();
  });

  it("clicking a family writes exactly that choice to the store", () => {
    render();
    act(() => {
      familyButton("violet").click();
    });
    expect(useAccentStore.getState().choice).toBe("violet");
    expect(familyButton("violet").getAttribute("aria-pressed")).toBe("true");
  });

  const pickColour = (hex: string) => {
    const input = container.querySelector(
      'input[type="color"]',
    ) as HTMLInputElement;
    // React tracks the input's value itself; go through the native
    // setter so the change registers as a real edit.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setter.call(input, hex);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  };

  it("picking a custom colour stores it, selects custom, and shows the adjusted note when the guard moved it", () => {
    render();
    pickColour("#fde68a");
    const state = useAccentStore.getState();
    expect(state.choice).toBe("custom");
    expect(state.customHex).toBe("#fde68a");
    // #fde68a cannot be its own light-mode spring, so the honest
    // adjusted note is on the surface.
    expect(container.textContent).toContain("settings.accent.adjusted_note");
    expect(container.textContent).toContain("settings.accent.custom_label");
  });

  it("picking a colour that already reads in both modes shows no adjusted note", () => {
    render();
    pickColour("#149a6c");
    expect(useAccentStore.getState().choice).toBe("custom");
    expect(container.textContent).not.toContain(
      "settings.accent.adjusted_note",
    );
  });

  it("clicking the custom swatch re-selects a stored custom colour", () => {
    useAccentStore.setState({ choice: "lagoon", customHex: "#149a6c" });
    render();
    const input = container.querySelector(
      'input[type="color"]',
    ) as HTMLInputElement;
    act(() => {
      input.click();
    });
    expect(useAccentStore.getState().choice).toBe("custom");
    expect(useAccentStore.getState().customHex).toBe("#149a6c");
  });
});
