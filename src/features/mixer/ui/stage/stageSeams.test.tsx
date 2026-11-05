import React, { act } from "react";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { djSession } from "../../engine/djSession";
import { useDjModeStore } from "../../store/djModeStore";
import { ControlLevelSwitcher } from "./ControlLevelSwitcher";
import { DeckPerformanceControls } from "./DeckPerformanceControls";
import { LeaveStageButton } from "./LeaveStageButton";
import { midBlendFixture } from "./stageFixtures";
import type { StageControlIntents, StageDeckSnapshot } from "./stageSnapshot";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Component tests for the stage's engine-seam surfaces and the
// stage's back button, in the tree's createRoot + act idiom:
//   · the control-level switcher — the snapshot's level is the
//     pressed button, clicks emit the level intent, and without
//     the intent there is no switcher;
//   · the deck performance controls — active states read back
//     from the snapshot (an armed loop offers release, an open
//     roll is pressed), the move/loop/roll/bias intents carry
//     exactly what the hand did, a refusal is SAID, and a deck
//     holding no track says so;
//   · the back button — closes the view through the
//     mode store and touches nothing else: the session is not
//     stopped, paused, or even imported; and DjStageView mounts
//     it in both of its states.

function sourceOf(file: string): string {
  // Under this vitest pipeline a .tsx module's import.meta.url
  // comes back root-relative (file:///src/...), which no disk
  // read can open; the working directory is the tree root in
  // every run, so resolve from there first and keep the URL
  // branch for environments where it is a real file URL.
  const fromCwd = path.resolve(
    process.cwd(),
    `src/features/mixer/ui/stage/${file}`,
  );
  if (existsSync(fromCwd)) return readFileSync(fromCwd, "utf8");
  return readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
}

interface SeamCalls {
  level: unknown[][];
  bias: unknown[][];
  loop: unknown[][];
  roll: unknown[][];
  move: unknown[][];
}

function makeIntents(
  overrides: {
    loopResult?: boolean;
    moveResult?: boolean;
  } = {},
): { intents: StageControlIntents; calls: SeamCalls } {
  const calls: SeamCalls = {
    level: [],
    bias: [],
    loop: [],
    roll: [],
    move: [],
  };
  const intents: StageControlIntents = {
    onTrimChange: () => {},
    onEqChange: () => {},
    onFilterChange: () => {},
    onCrossfaderCurveChange: () => {},
    onFxAssign: () => {},
    onFxWetLevel: () => {},
    onControlLevel: (level) => {
      calls.level.push([level]);
    },
    onTempoBias: (deck, ratio) => {
      calls.bias.push([deck, ratio]);
    },
    onManualLoop: (deck, region) => {
      calls.loop.push([deck, region]);
      return overrides.loopResult ?? true;
    },
    onManualRoll: (deck, beats) => {
      calls.roll.push([deck, beats]);
    },
    onDeckMove: (deck, move) => {
      calls.move.push([deck, move]);
      return overrides.moveResult ?? true;
    },
  };
  return { intents, calls };
}

function deckSnapshot(
  overrides: Partial<StageDeckSnapshot> = {},
): StageDeckSnapshot {
  return { ...midBlendFixture.snapshot.decks[0], ...overrides };
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const el = Array.from(scope.querySelectorAll("button")).find((button) =>
    button.textContent?.trim().startsWith(text),
  );
  if (!el) throw new Error(`No button with text "${text}"`);
  return el;
}

function buttonByExactText(scope: ParentNode, text: string): HTMLButtonElement {
  const el = Array.from(scope.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === text,
  );
  if (!el) throw new Error(`No button with exact text "${text}"`);
  return el;
}

describe("stage engine-seam surfaces", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
    useDjModeStore.getState().setProOpen(false);
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

  it("control-level switcher: renders nothing without the level intent", async () => {
    const { intents } = makeIntents();
    delete intents.onControlLevel;
    await render(<ControlLevelSwitcher level="autonomous" intents={intents} />);
    expect(container.textContent).toBe("");
  });

  it("control-level switcher: the snapshot's level is pressed; clicks emit levels", async () => {
    const { intents, calls } = makeIntents();
    await render(<ControlLevelSwitcher level="assisted" intents={intents} />);
    const assisted = buttonByText(container, "Assisted");
    expect(assisted.getAttribute("aria-pressed")).toBe("true");
    expect(
      buttonByText(container, "Fully autonomous").getAttribute("aria-pressed"),
    ).toBe("false");
    await click(buttonByText(container, "Manual"));
    expect(calls.level).toEqual([["manual"]]);
  });

  it("deck moves: the playing deck fires them; the standby deck cannot", async () => {
    const { intents, calls } = makeIntents();
    await render(
      <DeckPerformanceControls
        deck={0}
        snapshot={deckSnapshot()}
        intents={intents}
        live
        positionSec={42.5}
      />,
    );
    await click(buttonByText(container, "Brake"));
    await click(buttonByText(container, "Chirp"));
    expect(calls.move).toEqual([
      [0, "brake"],
      [0, "chirp"],
    ]);

    await render(
      <DeckPerformanceControls
        deck={1}
        snapshot={deckSnapshot({ trackId: null, positionSec: null })}
        intents={intents}
        live={false}
        positionSec={null}
      />,
    );
    expect(buttonByText(container, "Brake").disabled).toBe(true);
    // The standby deck says the truth about itself.
    expect(container.textContent).toContain("holds no track");
  });

  it("deck moves: a refusal is said out loud", async () => {
    const { intents } = makeIntents({ moveResult: false });
    await render(
      <DeckPerformanceControls
        deck={0}
        snapshot={deckSnapshot()}
        intents={intents}
        live
        positionSec={42.5}
      />,
    );
    await click(buttonByText(container, "Spinback"));
    expect(container.textContent).toContain(
      "That move can't be performed right now.",
    );
  });

  it("manual loop: arms from the playhead with the chosen beats; an armed loop offers release", async () => {
    const { intents, calls } = makeIntents();
    await render(
      <DeckPerformanceControls
        deck={0}
        snapshot={deckSnapshot()}
        intents={intents}
        live
        positionSec={42.5}
      />,
    );
    await click(buttonByText(container, "Loop from here"));
    expect(calls.loop).toEqual([[0, { startSec: 42.5, beats: 8 }]]);

    await render(
      <DeckPerformanceControls
        deck={0}
        snapshot={deckSnapshot({ manualLoop: { startSec: 42.5, beats: 8 } })}
        intents={intents}
        live
        positionSec={50}
      />,
    );
    await click(buttonByText(container, "Looping 8 beats"));
    expect(calls.loop).toEqual([
      [0, { startSec: 42.5, beats: 8 }],
      [0, null],
    ]);
  });

  it("manual roll: the snapshot's open roll is the pressed choice; clicking it releases", async () => {
    const { intents, calls } = makeIntents();
    await render(
      <DeckPerformanceControls
        deck={0}
        snapshot={deckSnapshot({ manualRollBeats: 1 })}
        intents={intents}
        live
        positionSec={42.5}
      />,
    );
    const one = buttonByExactText(container, "1");
    expect(one.getAttribute("aria-pressed")).toBe("true");
    await click(one);
    expect(calls.roll).toEqual([[0, null]]);
    await click(buttonByExactText(container, "2"));
    expect(calls.roll).toEqual([
      [0, null],
      [0, 2],
    ]);
  });

  it("tempo bias: the fader emits ratios, and a standing bias offers Reset", async () => {
    const { intents, calls } = makeIntents();
    await render(
      <DeckPerformanceControls
        deck={0}
        snapshot={deckSnapshot({ tempoBias: 1.05 })}
        intents={intents}
        live
        positionSec={42.5}
      />,
    );
    await click(buttonByText(container, "Reset"));
    expect(calls.bias).toEqual([[0, 1]]);

    const slider = container.querySelector(
      '[role="slider"][aria-label="Deck 1 tempo bias"]',
    ) as HTMLElement | null;
    if (!slider) throw new Error("No tempo bias slider");
    await pressKey(slider, "ArrowDown");
    expect(calls.bias.length).toBe(2);
    const [, ratio] = calls.bias[1] as [number, number];
    expect(ratio).toBeLessThan(1.05);
    expect(ratio).toBeGreaterThan(1);
  });

  it("back button: closes the view and leaves the session untouched", async () => {
    const stopSpy = vi.spyOn(djSession, "stop");
    const pauseSpy = vi.spyOn(djSession, "pause");
    useDjModeStore.getState().setProOpen(true);
    await render(<LeaveStageButton />);
    const back = buttonByText(container, "Back");
    expect(back.getAttribute("aria-label")).toBe("Back");
    await click(back);
    expect(useDjModeStore.getState().proOpen).toBe(false);
    // A view act only: the session was never told anything.
    expect(stopSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(djSession.isRunning).toBe(false);
    stopSpy.mockRestore();
    pauseSpy.mockRestore();
    // And the button's own module never reaches for the session.
    expect(sourceOf("LeaveStageButton.tsx")).not.toContain("djSession");
  });

  it("back button: DjStageView mounts it in both of its states", () => {
    const source = sourceOf("DjStageView.tsx");
    const mounts = source.match(/<LeaveStageButton/g) ?? [];
    expect(mounts.length).toBeGreaterThanOrEqual(2);
  });
});
