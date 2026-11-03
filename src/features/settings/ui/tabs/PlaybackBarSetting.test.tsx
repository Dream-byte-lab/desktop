import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/languages", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  getTranslationsForAllLocales: (key: string) => [key],
}));

import {
  resolveBarExpanded,
  usePlayerBarSizeStore,
  type ResolveBarExpandedInput,
} from "@/features/player/ui/playerBarSize";
import { PlaybackBarSetting } from "./PlaybackBarSetting";

// The mocked translation returns each key as its own text, so the
// three options are found by their locale keys.
const AUTO = "settings.playback_bar.auto";
const STANDARD = "settings.playback_bar.standard";
const EXPANDED = "settings.playback_bar.expanded";

type Signals = Partial<
  Pick<ResolveBarExpandedInput, "hovered" | "focusWithin" | "popupOpen">
>;

// Feed the store's current value through the bar's own resolver,
// exactly as MiniPlayer does.
function resolvedFromStore(signals: Signals = {}): boolean {
  return resolveBarExpanded({
    pinned: usePlayerBarSizeStore.getState().pinned,
    hovered: false,
    focusWithin: false,
    popupOpen: false,
    ...signals,
  });
}

describe("PlaybackBarSetting — the playback bar pin control", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    usePlayerBarSizeStore.setState({ pinned: null });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    usePlayerBarSizeStore.setState({ pinned: null });
    vi.restoreAllMocks();
  });

  const optionButton = (label: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === label,
    );

  const clickOption = (label: string) => {
    const button = optionButton(label);
    expect(button).toBeDefined();
    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  const renderSetting = () => {
    act(() => root.render(<PlaybackBarSetting />));
  };

  it("clicking Auto clears the pin, and the bar then follows hover", () => {
    usePlayerBarSizeStore.setState({ pinned: "expanded" });
    renderSetting();

    clickOption(AUTO);

    expect(usePlayerBarSizeStore.getState().pinned).toBeNull();
    expect(resolvedFromStore()).toBe(false);
    expect(resolvedFromStore({ hovered: true })).toBe(true);
    expect(optionButton(AUTO)!.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking Standard pins standard, and the bar stays compact even hovered", () => {
    renderSetting();

    clickOption(STANDARD);

    expect(usePlayerBarSizeStore.getState().pinned).toBe("standard");
    expect(resolvedFromStore({ hovered: true })).toBe(false);
    expect(
      resolvedFromStore({ hovered: true, focusWithin: true, popupOpen: true }),
    ).toBe(false);
    expect(optionButton(STANDARD)!.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicking Expanded pins expanded, and the bar is expanded with no signals", () => {
    usePlayerBarSizeStore.setState({ pinned: "standard" });
    renderSetting();

    clickOption(EXPANDED);

    expect(usePlayerBarSizeStore.getState().pinned).toBe("expanded");
    expect(resolvedFromStore()).toBe(true);
    expect(optionButton(EXPANDED)!.getAttribute("aria-pressed")).toBe("true");
  });

  it("reflects a pre-set store value: Expanded is the pressed option", () => {
    usePlayerBarSizeStore.setState({ pinned: "expanded" });
    renderSetting();

    expect(optionButton(EXPANDED)!.getAttribute("aria-pressed")).toBe("true");
    expect(optionButton(AUTO)!.getAttribute("aria-pressed")).toBe("false");
    expect(optionButton(STANDARD)!.getAttribute("aria-pressed")).toBe("false");
  });
});
