import React, { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StageBackButton } from "./StageBackButton";
import { StageBackCoverProbe } from "./StageBackCoverProbe";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Tests for the Note 26 cover probe (diagnostic instrumentation),
// in the stage's createRoot + act idiom. jsdom has no layout and
// its elementFromPoint is a stub, so both are mocked here:
// getBoundingClientRect gives every element the same plausible
// box, and each test decides what elementFromPoint finds at the
// Back pill's centre. The pill under test is the real
// StageBackButton, wired through its `buttonRef` exactly as
// DjStageView wires it — so these tests also pin that the button
// forwards the ref to a real <button> element.

const RECT = {
  left: 10,
  top: 10,
  width: 80,
  height: 32,
  right: 90,
  bottom: 42,
  x: 10,
  y: 10,
  toJSON: () => ({}),
} as DOMRect;

function Harness() {
  const backButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <StageBackButton buttonRef={backButtonRef} />
      <StageBackCoverProbe targetRef={backButtonRef} />
    </div>
  );
}

describe("StageBackCoverProbe (Note 26 diagnostic)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let originalFromPoint: typeof document.elementFromPoint;

  beforeEach(() => {
    rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(RECT);
    originalFromPoint = document.elementFromPoint;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
    document.body.innerHTML = "";
    rectSpy.mockRestore();
    document.elementFromPoint = originalFromPoint;
  });

  function renderWithTop(top: Element | null) {
    document.elementFromPoint = vi.fn(() => top);
    act(() => {
      root.render(<Harness />);
    });
  }

  function chip(): HTMLElement | null {
    return container.querySelector("[data-stage-back-cover-probe]");
  }

  it("names the covering element when something foreign sits on the pill", () => {
    const coverEl = document.createElement("div");
    coverEl.id = "snap-preview";
    coverEl.className = "fixed inset-0";
    document.body.appendChild(coverEl);

    renderWithTop(coverEl);

    expect(chip()).not.toBeNull();
    expect(chip()!.textContent).toBe(
      "Back button covered by: div#snap-preview.fixed",
    );
  });

  it("renders nothing when the pill itself is on top", () => {
    // Lazy lookup: the pill only exists once the render commits,
    // which is before the probe's mount effect asks.
    document.elementFromPoint = vi.fn(() => container.querySelector("button"));
    act(() => {
      root.render(<Harness />);
    });
    expect(chip()).toBeNull();
  });

  it("renders nothing when one of the pill's own children is on top", () => {
    document.elementFromPoint = vi.fn(() =>
      container.querySelector("button span"),
    );
    act(() => {
      root.render(<Harness />);
    });
    expect(chip()).toBeNull();
  });

  it("renders nothing when elementFromPoint finds no element at all", () => {
    renderWithTop(null);
    expect(chip()).toBeNull();
  });
});
