import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/languages", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  getTranslationsForAllLocales: (key: string) => [key],
}));

// The "@/features/overlay" barrel also re-exports the overlay
// player UI chain (lottie/canvas), which jsdom cannot load. The
// tab needs only the store, the size lib and the shortcut utils
// — serve the barrel from those real submodules.
vi.mock("@/features/overlay", async () => {
  const store = await import("@/features/overlay/store/overlaySettingsStore");
  const size = await import("@/features/overlay/lib/overlaySize");
  const shortcut = await import("@/features/overlay/lib/shortcutUtils");
  const contracts = await import("@/features/overlay/contracts");
  return { ...contracts, ...store, ...size, ...shortcut };
});

import { useOverlaySettingsStore } from "@/features/overlay/store/overlaySettingsStore";
import { OverlayTab } from "./OverlayTab";

// The mocked translation returns each key as its own text, so
// controls are found by their locale keys (the AccentSetting
// test's idiom).

describe("OverlayTab — the size control's Custom option (fix-0119)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    useOverlaySettingsStore.setState({ size: { width: 600, height: 344 } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
  });

  const render = () => {
    act(() => {
      root.render(<OverlayTab />);
    });
  };

  const sizeButton = (id: string) =>
    Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === `settings.overlay.size.${id}`,
    ) as HTMLButtonElement;

  const click = (button: HTMLButtonElement) => {
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };

  it("Custom is a real selectable option that holds the current size as custom — even when it equals a preset", () => {
    render();
    expect(sizeButton("default").getAttribute("aria-pressed")).toBe("true");
    expect(sizeButton("custom").getAttribute("aria-pressed")).toBe("false");

    click(sizeButton("custom"));

    // The pre-fix control deliberately ignored this press.
    expect(sizeButton("custom").getAttribute("aria-pressed")).toBe("true");
    expect(sizeButton("default").getAttribute("aria-pressed")).toBe("false");
    // Selecting Custom never moves the size itself.
    expect(useOverlaySettingsStore.getState().size).toEqual({
      width: 600,
      height: 344,
    });
  });

  it("picking a preset after Custom returns the control to that preset and its size", () => {
    render();
    click(sizeButton("custom"));
    click(sizeButton("small"));
    expect(sizeButton("small").getAttribute("aria-pressed")).toBe("true");
    expect(sizeButton("custom").getAttribute("aria-pressed")).toBe("false");
    expect(useOverlaySettingsStore.getState().size).toEqual({
      width: 320,
      height: 64,
    });
  });

  it("a size no preset matches (a grip drag) reads Custom without any hold", () => {
    useOverlaySettingsStore.setState({ size: { width: 500, height: 300 } });
    render();
    expect(sizeButton("custom").getAttribute("aria-pressed")).toBe("true");
  });

  it("an external size change releases a stale Custom hold", () => {
    render();
    click(sizeButton("custom"));
    expect(sizeButton("custom").getAttribute("aria-pressed")).toBe("true");
    // The grip (or a hydrate) moves the size: the matched display
    // governs again — here the new size IS the small preset.
    act(() => {
      useOverlaySettingsStore.setState({ size: { width: 320, height: 64 } });
    });
    expect(sizeButton("small").getAttribute("aria-pressed")).toBe("true");
    expect(sizeButton("custom").getAttribute("aria-pressed")).toBe("false");
  });
});
