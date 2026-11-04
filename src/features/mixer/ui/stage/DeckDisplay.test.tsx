import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STANDARD_PROFILE } from "../../engine/decisionProfile";
import { DeckDisplay } from "./DeckDisplay";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// The "(low confidence)" note's threshold, pinned both sides
// (0.1.15 integration, from note27-c2-fix.md's residual): the
// label means "below the STANDARD mixing floor" on the repaired
// mean-centred tempo-confidence scale. The old 0.5 line belonged
// to the uncentred statistic, on which the measured real
// recording reads 0.169 and wore the label while mixing fine.

const FLOOR = STANDARD_PROFILE.minTempoConfidence;

function renderDisplay(tempoConfidence: number | null) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <DeckDisplay
        deckLabel="Deck A"
        role="Live"
        title="Song"
        artists="Artist"
        bpm={123}
        tempoConfidence={tempoConfidence}
        keyLabel={null}
        elapsedSec={30}
        durationSec={200}
      />,
    );
  });
  return { container, root };
}

describe("DeckDisplay — the low-confidence note", () => {
  let mounted: { container: HTMLDivElement; root: Root } | null = null;

  beforeEach(() => {
    mounted = null;
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = null;
    }
  });

  it("shows the note just below the STANDARD floor", () => {
    mounted = renderDisplay(FLOOR - 0.01);
    expect(mounted.container.textContent).toContain("(low confidence)");
  });

  it("hides the note at the STANDARD floor itself", () => {
    mounted = renderDisplay(FLOOR);
    expect(mounted.container.textContent).not.toContain("(low confidence)");
  });

  it("hides the note for the measured real recording (0.169)", () => {
    mounted = renderDisplay(0.169);
    expect(mounted.container.textContent).not.toContain("(low confidence)");
    expect(mounted.container.textContent).toContain("123.0 BPM");
  });

  it("hides the note when there is no confidence to judge (null)", () => {
    mounted = renderDisplay(null);
    expect(mounted.container.textContent).not.toContain("(low confidence)");
  });
});
