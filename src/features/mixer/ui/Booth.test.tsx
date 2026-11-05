import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { useDjSettings } from "@/features/mixer/liverave/settings";
import { useDjState } from "@/features/mixer/liverave/state";
import { usePlayerStore } from "@/features/player/store/playerStore";
import { Booth } from "./Booth";
import { makeFakeSession, makeTrack } from "./fakeSession";

function resetStores(proOpen: boolean) {
  const t1 = makeTrack("t1", "Song One");
  useDjState.setState({
    intent: true,
    active: true,
    blending: true,
    proOpen,
    controlLevel: "autonomous",
  });
  useDjSettings.setState({
    personalityId: "autonomous",
    sliders: {
      intensity: 0.5,
      creativity: 0.5,
      scratching: 0.5,
      effects: 0.5,
      transitionComplexity: 0.5,
      genreFlexibility: 0.5,
      energyProgression: 0.5,
      trackSelectionFreedom: 0.5,
    },
  });
  usePlayerStore.setState({
    queue: [t1, makeTrack("t2", "Song Two"), makeTrack("t3", "Song Three")],
    currentIndex: 0,
    currentTrack: t1,
    status: "playing",
  });
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Booth — the take-over performance view (§10.3)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("renders nothing until the Booth is deliberately opened", () => {
    resetStores(false);
    act(() => root.render(<Booth session={makeFakeSession()} />));
    expect(container.querySelector("[data-testid='booth']")).toBeNull();
  });

  it("lands on the performance column: the real candidate pool, the drawn pick lit", () => {
    resetStores(true);
    act(() => root.render(<Booth session={makeFakeSession()} />));
    const cards = container.querySelectorAll("[data-pool-card]");
    expect(cards).toHaveLength(2);
    const drawn = container.querySelector("[data-pool-card='drawn']");
    expect(drawn?.textContent).toContain("FLARE SCRATCH");
    expect(drawn?.textContent).toContain("Song Two");
    expect(drawn?.textContent).toContain("drawn pick");
    const candidate = container.querySelector("[data-pool-card='candidate']");
    expect(candidate?.textContent).toContain("BLEND");
    expect(candidate?.textContent).toContain("Song Three");
  });

  it("shows the activity feed verbatim and the behaviour ledger with its distribution", () => {
    resetStores(true);
    act(() => root.render(<Booth session={makeFakeSession()} />));
    const feed = container.querySelector("[data-activity-feed]");
    expect(feed?.textContent).toContain('Set started with "Song One"');
    expect(feed?.textContent).toContain("Plain cut into");
    const ledger = container.querySelector("[data-ledger-distribution]");
    expect(ledger?.textContent).toContain("2 records");
    expect(ledger?.textContent).toContain("fallback-unprepared 1");
    const records = container.querySelector("[data-ledger-records]");
    expect(records?.textContent).toContain("FALLBACK · fallback-unprepared");
  });

  it("deck platters carry the snapshot's decks and render the held facts as numerals", () => {
    resetStores(true);
    act(() => root.render(<Booth session={makeFakeSession()} />));
    const decks = container.querySelector("[data-booth-decks]");
    const deckA = decks?.querySelector("[data-deck='A']");
    expect(deckA?.textContent).toContain("Song One");
    expect(decks?.querySelector("[data-deck='B']")?.textContent).toContain(
      "Song Two",
    );
    // Deck A's facts (the fake's fixtures): BPM, key, energy now,
    // the trust line, and the contour in the platter area.
    expect(deckA?.querySelector("[data-deck-facts='present']")).not.toBeNull();
    expect(deckA?.querySelector("[data-deck-bpm]")?.textContent).toContain(
      "124",
    );
    expect(deckA?.querySelector("[data-deck-key]")?.textContent).toContain(
      "8A",
    );
    expect(deckA?.querySelector("[data-deck-energy]")?.textContent).toContain(
      "0.42",
    );
    expect(deckA?.textContent).toContain("beatmatch trusted");
    expect(deckA?.querySelector("[data-deck-contour]")).not.toBeNull();
    // No gap notice remains anywhere under the platters.
    expect(decks?.textContent).not.toContain("does not expose per-deck facts");
  });

  it("a deck with null facts states truthfully that no analysis is held", () => {
    resetStores(true);
    act(() => root.render(<Booth session={makeFakeSession()} />));
    const deckB = container.querySelector("[data-deck='B']");
    expect(deckB?.querySelector("[data-deck-facts='absent']")).not.toBeNull();
    expect(deckB?.textContent).toContain("No analysis held for this deck yet");
    expect(deckB?.querySelector("[data-deck-facts='present']")).toBeNull();
  });

  it("both decks null: neither invents numerals and both state the absence", () => {
    resetStores(true);
    act(() =>
      root.render(
        <Booth session={makeFakeSession({ deckFacts: [null, null] })} />,
      ),
    );
    const absent = container.querySelectorAll("[data-deck-facts='absent']");
    expect(absent).toHaveLength(2);
    expect(
      container.querySelectorAll("[data-deck-facts='present']"),
    ).toHaveLength(0);
    expect(container.querySelector("[data-deck-contour]")).toBeNull();
  });

  it("facts with an empty contour render numerals without a contour", () => {
    resetStores(true);
    const session = makeFakeSession({
      deckFacts: [
        {
          bpm: 98,
          keyCamelot: null,
          beatmatchTrusted: false,
          energyNow: 0.1,
          energyContour: [],
        },
        null,
      ],
    });
    act(() => root.render(<Booth session={session} />));
    const deckA = container.querySelector("[data-deck='A']");
    expect(deckA?.querySelector("[data-deck-bpm]")?.textContent).toContain(
      "98",
    );
    expect(deckA?.querySelector("[data-deck-key]")?.textContent).toContain("—");
    expect(deckA?.textContent).toContain("beatmatch untrusted");
    expect(deckA?.querySelector("[data-deck-contour]")).toBeNull();
  });

  it("personality tiles are wired to useDjSettings", () => {
    resetStores(true);
    act(() => root.render(<Booth session={makeFakeSession()} />));
    const battle = container.querySelector("[data-personality-tile='battle']");
    expect(battle).not.toBeNull();
    click(battle!);
    expect(useDjSettings.getState().personalityId).toBe("battle");
    expect(battle!.getAttribute("aria-pressed")).toBe("true");
  });

  it("slider strips are wired to useDjSettings and speak their live effect", () => {
    resetStores(true);
    act(() => root.render(<Booth session={makeFakeSession()} />));
    const strip = container.querySelector("[data-slider-strip='scratching']");
    const input = strip?.querySelector<HTMLInputElement>("input[type='range']");
    expect(input).not.toBeNull();
    // React tracks range values through the native setter.
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    act(() => {
      setter?.call(input, "0.9");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(useDjSettings.getState().sliders.scratching).toBeCloseTo(0.9);
    expect(
      container.querySelector("[data-slider-effect='scratching']")?.textContent,
    ).toContain("battle-leaning");
  });

  it("expert tier: a refused deck move surfaces the engine's own reason", async () => {
    resetStores(true);
    const session = makeFakeSession();
    act(() => root.render(<Booth session={session} />));
    const move = container.querySelector("[data-deck-move='scratch-in']");
    click(move!);
    await act(async () => {});
    expect(session.triggerDeckMove).toHaveBeenCalledWith({
      kind: "scratch-in",
    });
    expect(
      container.querySelector("[data-expert-message]")?.textContent,
    ).toContain("Refused: join-locked");
  });

  it("expert tier: a refused curate surfaces its honest reason", async () => {
    resetStores(true);
    const session = makeFakeSession({
      curateResult: { ok: false, reason: "not-enough-ready" },
    });
    act(() => root.render(<Booth session={session} />));
    click(container.querySelector("[data-curate]")!);
    await act(async () => {});
    expect(
      container.querySelector("[data-expert-message]")?.textContent,
    ).toContain("Curate refused: not-enough-ready");
  });

  it("expert tier: control level writes both the state store and the session", () => {
    resetStores(true);
    const session = makeFakeSession();
    act(() => root.render(<Booth session={session} />));
    click(container.querySelector("[data-control-level='manual']")!);
    expect(useDjState.getState().controlLevel).toBe("manual");
    expect(session.setControlLevel).toHaveBeenCalledWith("manual");
  });

  it("Leave closes the Booth through proOpen", () => {
    resetStores(true);
    act(() => root.render(<Booth session={makeFakeSession()} />));
    click(container.querySelector('button[aria-label="Leave the Booth"]')!);
    expect(useDjState.getState().proOpen).toBe(false);
  });
});
