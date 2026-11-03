import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SLIDERS,
  PERSONALITIES,
  PERSONALITY_IDS,
  type PersonalityId,
  type SliderSettings,
} from "../../engine/personality";
import {
  activeSlidersOf,
  usePersonalityStore,
} from "../../store/personalityStore";
import { PersonalityPanel } from "./PersonalityPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Component tests for the R4 personality panel, in the stage's
// createRoot + act idiom. The panel's only seam is the personality
// store (a module singleton), so the store is reset to defaults
// before every test and assertions read it back directly.

const SLIDER_LABELS = [
  "Intensity",
  "Creativity",
  "Scratching",
  "Effects",
  "Transition complexity",
  "Genre flexibility",
  "Energy progression",
  "Track-selection freedom",
] as const;

function defaultSlidersByPersonality(): Record<PersonalityId, SliderSettings> {
  const result = {} as Record<PersonalityId, SliderSettings>;
  for (const id of PERSONALITY_IDS) {
    result[id] = { ...DEFAULT_SLIDERS };
  }
  return result;
}

function resetPersonalityStore() {
  usePersonalityStore.setState({
    personalityId: "autonomous",
    slidersByPersonality: defaultSlidersByPersonality(),
  });
}

function sliderByLabel(scope: ParentNode, label: string): HTMLElement {
  const el = scope.querySelector(
    `[role="slider"][aria-label="${label}"]`,
  ) as HTMLElement | null;
  if (!el) throw new Error(`No slider labelled "${label}"`);
  return el;
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const el = Array.from(scope.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  );
  if (!el) throw new Error(`No button with text "${text}"`);
  return el;
}

function maybeButtonByText(
  scope: ParentNode,
  text: string,
): HTMLButtonElement | undefined {
  return Array.from(scope.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  );
}

describe("personality panel (R4)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    resetPersonalityStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
    resetPersonalityStore();
  });

  async function render(node: React.ReactNode) {
    await act(async () => {
      root.render(node);
    });
  }

  async function click(el: HTMLButtonElement) {
    await act(async () => {
      el.click();
    });
  }

  async function pressKey(el: HTMLElement, key: string) {
    await act(async () => {
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }

  it("renders all seven personality chips and all eight slider labels", async () => {
    await render(<PersonalityPanel />);

    for (const id of PERSONALITY_IDS) {
      const chip = buttonByText(container, PERSONALITIES[id].label);
      expect(chip.getAttribute("aria-pressed")).toBe(
        id === "autonomous" ? "true" : "false",
      );
    }

    for (const label of SLIDER_LABELS) {
      expect(sliderByLabel(container, label)).not.toBeNull();
      expect(container.textContent).toContain(label);
    }

    expect(container.textContent).toContain(
      "Each personality remembers its own slider bends.",
    );
  });

  it("sets the store's personality when the Battle chip is clicked", async () => {
    await render(<PersonalityPanel />);

    await click(buttonByText(container, "Battle"));

    expect(usePersonalityStore.getState().personalityId).toBe("battle");
    expect(buttonByText(container, "Battle").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      buttonByText(container, "Autonomous").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("bends the active personality's slider when a fader is stepped by keyboard", async () => {
    await render(<PersonalityPanel />);

    // The fader steps range/50 per arrow key: 50 + 100/50 = 52 -> 0.52.
    await pressKey(sliderByLabel(container, "Intensity"), "ArrowUp");

    expect(activeSlidersOf(usePersonalityStore.getState()).intensity).toBe(
      0.52,
    );
  });

  it("hides Reset sliders at defaults and restores defaults when it is clicked after a bend", async () => {
    await render(<PersonalityPanel />);

    expect(maybeButtonByText(container, "Reset sliders")).toBeUndefined();

    // The reset path is driven through the store: the Fader's
    // pointer geometry is not meaningful under jsdom.
    await act(async () => {
      usePersonalityStore.getState().setSlider("creativity", 0.9);
    });
    expect(activeSlidersOf(usePersonalityStore.getState()).creativity).toBe(
      0.9,
    );

    const reset = buttonByText(container, "Reset sliders");
    await click(reset);

    expect(activeSlidersOf(usePersonalityStore.getState())).toEqual(
      DEFAULT_SLIDERS,
    );
    expect(maybeButtonByText(container, "Reset sliders")).toBeUndefined();
  });
});
