// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import {
  isRomanizationEnabled,
  romanizeIfEnabled,
  useRomanizationStore,
} from "./romanizationStore";
import { useRomanized } from "./useRomanized";
import { romanize } from "./romanize";
import { debouncedStorage } from "@/shared/utils/storage";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function Probe({ text }: { text: string }) {
  const romanized = useRomanized(text);
  return <span>{romanized ?? ""}</span>;
}

describe("romanization store + consumer hook", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    act(() => {
      useRomanizationStore.setState({ enabled: true });
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    act(() => {
      useRomanizationStore.setState({ enabled: true });
    });
  });

  it("defaults to enabled", () => {
    expect(isRomanizationEnabled()).toBe(true);
  });

  it("romanizes at a consumer while on, and yields nothing while off", () => {
    act(() => root.render(<Probe text="Москва" />));
    expect(container.textContent).toBe("Moskva");

    act(() => {
      useRomanizationStore.getState().setEnabled(false);
    });
    expect(container.textContent).toBe("");

    act(() => {
      useRomanizationStore.getState().setEnabled(true);
    });
    expect(container.textContent).toBe("Moskva");
  });

  it("gates the non-hook helper the same way", () => {
    expect(romanizeIfEnabled("Москва", romanize)).toBe("Moskva");
    act(() => {
      useRomanizationStore.getState().setEnabled(false);
    });
    expect(romanizeIfEnabled("Москва", romanize)).toBeNull();
    expect(romanizeIfEnabled(null, romanize)).toBeNull();
  });

  it("persists the toggle through the debounced storage idiom", () => {
    act(() => {
      useRomanizationStore.getState().setEnabled(false);
    });
    debouncedStorage.flush();
    const raw = localStorage.getItem("liner_romanization_v1");
    expect(raw).toContain('"enabled":false');
  });
});
