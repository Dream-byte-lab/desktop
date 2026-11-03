import React, { act } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Knob } from "./Knob";
import { StageSnapshotControls } from "./StageSnapshotControls";
import { degradedFixture, idleFixture, midBlendFixture } from "./stageFixtures";
import { STAGE_EFFECT_LABELS, type StageControlIntents } from "./stageSnapshot";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Component tests for the Build 2A snapshot-driven controls, in the
// tree's createRoot + act idiom. Everything is driven by the paired
// fixtures; the intents are plain recorders, so each assertion is
// about exactly what a component emitted for a given snapshot.

interface RecordedCalls {
  trim: unknown[][];
  eq: unknown[][];
  filter: unknown[][];
  curve: unknown[][];
  fxAssign: unknown[][];
  fxWetLevel: unknown[][];
}

function makeIntents(): { intents: StageControlIntents; calls: RecordedCalls } {
  const calls: RecordedCalls = {
    trim: [],
    eq: [],
    filter: [],
    curve: [],
    fxAssign: [],
    fxWetLevel: [],
  };
  const intents: StageControlIntents = {
    onTrimChange: (deck, ratio) => {
      calls.trim.push([deck, ratio]);
    },
    onEqChange: (deck, band, db) => {
      calls.eq.push([deck, band, db]);
    },
    onFilterChange: (deck, hz) => {
      calls.filter.push([deck, hz]);
    },
    onCrossfaderCurveChange: (curve) => {
      calls.curve.push([curve]);
    },
    onFxAssign: (kind, assign) => {
      calls.fxAssign.push([kind, assign]);
    },
    onFxWetLevel: (kind, side, level) => {
      calls.fxWetLevel.push([kind, side, level]);
    },
  };
  return { intents, calls };
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

describe("stage controls (Build 2A)", () => {
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
  });

  async function render(node: React.ReactNode) {
    await act(async () => {
      root.render(node);
    });
  }

  async function pressKey(el: HTMLElement, key: string) {
    await act(async () => {
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  }

  async function click(el: HTMLButtonElement) {
    await act(async () => {
      el.click();
    });
  }

  it("renders nothing when the snapshot is undefined", async () => {
    const { intents } = makeIntents();
    await render(
      <StageSnapshotControls
        snapshot={undefined}
        trims={[1, 1]}
        intents={intents}
      />,
    );
    expect(container.childNodes).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the snapshot is null", async () => {
    const { intents } = makeIntents();
    await render(
      <StageSnapshotControls
        snapshot={null}
        trims={[1, 1]}
        intents={intents}
      />,
    );
    expect(container.childNodes).toHaveLength(0);
    expect(container.textContent).toBe("");
  });

  it("renders both channel strips, three live meters and all eight effects for the mid-blend fixture", async () => {
    const { intents } = makeIntents();
    await render(
      <StageSnapshotControls
        snapshot={midBlendFixture.snapshot}
        trims={[1, 1]}
        intents={intents}
      />,
    );

    const stripA = container.querySelector('[data-testid="channel-strip-A"]');
    const stripB = container.querySelector('[data-testid="channel-strip-B"]');
    expect(stripA).not.toBeNull();
    expect(stripB).not.toBeNull();

    // Deck A's bass sits at -6 dB in the fixture.
    const bassA = sliderByLabel(stripA as ParentNode, "Bass");
    expect(bassA.getAttribute("aria-valuenow")).toBe("-6");

    const meters = container.querySelectorAll('[data-testid^="meter-"]');
    expect(meters).toHaveLength(3);
    expect(container.textContent).not.toContain("No meter path");

    for (const label of Object.values(STAGE_EFFECT_LABELS)) {
      expect(container.textContent).toContain(label);
    }
    expect(container.querySelectorAll('[data-testid^="fx-row-"]')).toHaveLength(
      8,
    );
  });

  it("emits onEqChange stepped by range/50 when deck A's bass knob gets ArrowUp", async () => {
    const { intents, calls } = makeIntents();
    await render(
      <StageSnapshotControls
        snapshot={midBlendFixture.snapshot}
        trims={[1, 1]}
        intents={intents}
      />,
    );
    const stripA = container.querySelector(
      '[data-testid="channel-strip-A"]',
    ) as ParentNode;
    await pressKey(sliderByLabel(stripA, "Bass"), "ArrowUp");

    expect(calls.eq).toHaveLength(1);
    const [deck, band, db] = calls.eq[0] as [number, string, number];
    expect(deck).toBe(0);
    expect(band).toBe("bass");
    // -6 + 48/50 = -5.04
    expect(Math.abs(db - (-6 + 48 / 50))).toBeLessThan(1e-9);
  });

  it("emits onTrimChange as a ratio when a trim fader gets ArrowUp", async () => {
    const { intents, calls } = makeIntents();
    await render(
      <StageSnapshotControls
        snapshot={midBlendFixture.snapshot}
        trims={[1, 1]}
        intents={intents}
      />,
    );
    const stripA = container.querySelector(
      '[data-testid="channel-strip-A"]',
    ) as ParentNode;
    await pressKey(sliderByLabel(stripA, "Trim"), "ArrowUp");

    expect(calls.trim).toHaveLength(1);
    const [deck, ratio] = calls.trim[0] as [number, number];
    expect(deck).toBe(0);
    // 100% + 125/50 = 102.5% -> ratio 1.025
    expect(Math.abs(ratio - 1.025)).toBeLessThan(1e-9);
  });

  it("emits onFxAssign when the reverb row's B assign button is clicked", async () => {
    const { intents, calls } = makeIntents();
    await render(
      <StageSnapshotControls
        snapshot={midBlendFixture.snapshot}
        trims={[1, 1]}
        intents={intents}
      />,
    );
    const reverbRow = container.querySelector(
      '[data-testid="fx-row-reverb"]',
    ) as ParentNode;
    // The fixture assigns reverb to A, so A starts pressed and B does not.
    expect(buttonByText(reverbRow, "A").getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(buttonByText(reverbRow, "B").getAttribute("aria-pressed")).toBe(
      "false",
    );

    await click(buttonByText(reverbRow, "B"));
    expect(calls.fxAssign).toEqual([["reverb", "B"]]);
  });

  it("emits onFxWetLevel stepped when a built effect's A-wet fader gets ArrowUp", async () => {
    const { intents, calls } = makeIntents();
    await render(
      <StageSnapshotControls
        snapshot={midBlendFixture.snapshot}
        trims={[1, 1]}
        intents={intents}
      />,
    );
    const reverbRow = container.querySelector(
      '[data-testid="fx-row-reverb"]',
    ) as ParentNode;
    await pressKey(sliderByLabel(reverbRow, "A wet"), "ArrowUp");

    expect(calls.fxWetLevel).toHaveLength(1);
    const [kind, side, level] = calls.fxWetLevel[0] as [string, string, number];
    expect(kind).toBe("reverb");
    expect(side).toBe("A");
    // Send A is 0.5 in the fixture; the fader steps 100/50 = 2 points.
    expect(Math.abs(level - 0.52)).toBeLessThan(1e-9);
  });

  it("emits onCrossfaderCurveChange and marks the snapshot's curve pressed", async () => {
    const { intents, calls } = makeIntents();
    await render(
      <StageSnapshotControls
        snapshot={midBlendFixture.snapshot}
        trims={[1, 1]}
        intents={intents}
      />,
    );
    // The fixture's curve is constant-power.
    expect(
      buttonByText(container, "Constant power").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(buttonByText(container, "Cut").getAttribute("aria-pressed")).toBe(
      "false",
    );

    await click(buttonByText(container, "Cut"));
    expect(calls.curve).toEqual([["cut"]]);
  });

  it("shows three 'No meter path' captions and no wet faders for the idle fixture", async () => {
    const { intents } = makeIntents();
    await render(
      <StageSnapshotControls
        snapshot={idleFixture.snapshot}
        trims={[1, 1]}
        intents={intents}
      />,
    );

    const captions = container.textContent?.match(/No meter path/g) ?? [];
    expect(captions).toHaveLength(3);

    const rows = container.querySelectorAll('[data-testid^="fx-row-"]');
    expect(rows).toHaveLength(8);
    for (const row of Array.from(rows)) {
      expect(row.textContent).toContain("Not built");
    }
    const wetSliders = container.querySelectorAll(
      '[data-testid^="fx-row-"] [role="slider"]',
    );
    expect(wetSliders).toHaveLength(0);
  });

  it("shows 'No meter path' only on deck B for the degraded fixture", async () => {
    const { intents } = makeIntents();
    await render(
      <StageSnapshotControls
        snapshot={degradedFixture.snapshot}
        trims={[1, 1]}
        intents={intents}
      />,
    );

    const meterA = container.querySelector('[data-testid="meter-Deck A"]');
    const meterB = container.querySelector('[data-testid="meter-Deck B"]');
    expect(meterA).not.toBeNull();
    expect(meterB).not.toBeNull();
    expect(meterB?.textContent).toContain("No meter path");
    expect(meterA?.textContent).not.toContain("No meter path");
  });

  it("snaps a knob keyed to within 2% of the range of its detent to exactly the detent", async () => {
    const emitted: number[] = [];
    await render(
      <Knob
        label="Detent check"
        value={-0.5}
        min={-24}
        max={24}
        detentValue={0}
        onChange={(v) => emitted.push(v)}
      />,
    );
    // Step is 48/50 = 0.96, so ArrowUp lands raw at 0.46 — within
    // 2% of the 48-wide range (0.96) of the detent at 0.
    await pressKey(sliderByLabel(container, "Detent check"), "ArrowUp");
    expect(emitted).toEqual([0]);
  });

  it("mounts the Build 2A controls on the live session snapshot (wiring regression)", () => {
    // Under vitest's jsdom environment import.meta.url is an http
    // URL, not a file URL, so resolve the file path from the URL
    // when its scheme allows it and from the tree root otherwise.
    const stageViewUrl = new URL("./DjStageView.tsx", import.meta.url);
    const source =
      stageViewUrl.protocol === "file:"
        ? readFileSync(stageViewUrl, "utf8")
        : readFileSync(
            path.resolve(
              process.cwd(),
              "src/features/mixer/ui/stage/DjStageView.tsx",
            ),
            "utf8",
          );
    expect(source).toContain("StageSnapshotControls");
    expect(source).toContain("activityLinesForStage");
    expect(source).toContain("stageSnapshot");
  });
});
