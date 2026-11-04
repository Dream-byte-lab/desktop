import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// the eight Wave 4 keys are owed to the parent's integration sweep;
// this stand-in translator serves them with exactly the English the
// sweep will land, so assertions read as the user will see them
const STRINGS: Record<string, string> = {
  "player.lyrics_source_word": "Word-synced",
  "player.lyrics_source_line": "Line-synced",
  "player.lyrics_source_plain": "Plain",
  "player.lyrics_wrong": "These lyrics are wrong",
  "player.lyrics_marked_wrong": "Marked as wrong",
  "player.lyrics_unmark": "Unmark",
  "player.lyrics_no_alternative": "No other source was found for this track",
};

vi.mock("@/languages", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      if (key === "player.lyrics_switch_to") {
        return `Switch to ${vars?.provider ?? ""}`;
      }
      return STRINGS[key] ?? key;
    },
  }),
}));

import { LyricsProviderIsland } from "./LyricsProviderIsland";
import {
  useLyricsStore,
  type LyricsProviderOption,
} from "../store/lyricsStore";
import { lyricsCache } from "../store/lyricsCache";
import { parseRawLyrics } from "../engine/lyricsParser";
import type {
  LyricsCandidate,
  LyricsSyncLevel,
} from "@/shared/contracts/lyrics";

// Wave 4 (wrong-lyrics remedy): the provider dropdown gains sync
// labels, explicit picks persist per track, and the footer carries
// the device-local wrong-source mark — marking never switches what
// is on screen by itself.

const TRACK_ID = "island-track-1";

function makeCandidate(
  provider: string,
  syncLevel: LyricsSyncLevel,
  qualityTotal: number,
  marker: string,
): LyricsCandidate {
  return {
    provider,
    contentKind: syncLevel === "word_level" ? "word_synced" : "line_synced",
    syncLevel,
    quality: {
      total: qualityTotal,
      match: 20,
      content: 30,
      sync: 30,
      source: 0,
      reasons: [],
    },
    lyrics: { format: "lrc", content: `[00:01.00] ${marker}` },
  };
}

function opt(candidate: LyricsCandidate): LyricsProviderOption {
  return {
    provider: candidate.provider,
    syncLevel: candidate.syncLevel,
    quality: candidate.quality.total,
    candidate,
  };
}

const alpha = makeCandidate("Alpha", "word_level", 90, "alpha words");
const beta = makeCandidate("Beta", "line_level", 70, "beta words");

let container: HTMLDivElement;
let root: Root;

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")];
}

function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((button) => button.textContent?.includes(text));
  if (!found) throw new Error(`no button containing "${text}"`);
  return found;
}

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function render() {
  act(() => {
    root.render(<LyricsProviderIsland />);
  });
}

function seedStore(providers: LyricsProviderOption[], active: string) {
  const activeOpt =
    providers.find((p) => p.provider === active) ?? providers[0];
  const parsed = parseRawLyrics(
    activeOpt.candidate.lyrics.content,
    activeOpt.candidate.lyrics.format,
  );
  useLyricsStore.setState({
    availableProviders: providers,
    activeProvider: activeOpt.provider,
    braccatoLyrics: parsed.braccatoLyrics,
    syncedLines: parsed.syncedLines,
    plainLyrics: parsed.plainLyrics,
    rawLyrics: activeOpt.candidate.lyrics.content,
    rawFormat: activeOpt.candidate.lyrics.format,
    currentLyricsTrackId: TRACK_ID,
    offsetMs: 0,
    trackOffsets: {},
  });
}

function seedTwoProviders() {
  seedStore([opt(alpha), opt(beta)], "Alpha");
  // the cache item is the pick/mark's home; the island writes need it
  lyricsCache.set(TRACK_ID, alpha, [opt(alpha), opt(beta)]);
  render();
}

function openDropdown() {
  click(buttonByText("1/2"));
}

beforeEach(() => {
  localStorage.clear();
  lyricsCache.clear();
  useLyricsStore.getState().reset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  localStorage.clear();
  lyricsCache.clear();
});

describe("LyricsProviderIsland — Wave 4", () => {
  it("dropdown rows carry sync labels from the option data", () => {
    seedTwoProviders();
    openDropdown();
    expect(container.textContent).toContain("Word-synced");
    expect(container.textContent).toContain("Line-synced");
  });

  it("choosing a row persists the pick for the track", () => {
    seedTwoProviders();
    openDropdown();
    click(buttonByText("Beta"));
    expect(useLyricsStore.getState().activeProvider).toBe("Beta");
    expect(lyricsCache.get(TRACK_ID)?.userProvider).toBe("beta");
  });

  it("the footer marks the active source wrong without switching it", () => {
    seedTwoProviders();
    openDropdown();
    click(buttonByText("These lyrics are wrong"));

    expect(lyricsCache.get(TRACK_ID)?.wrongProvider?.provider).toBe("alpha");
    // what is on screen does not change by itself
    expect(useLyricsStore.getState().activeProvider).toBe("Alpha");
    // the footer now states the mark and offers the explicit next step
    expect(container.textContent).toContain("Marked as wrong");
    expect(container.textContent).toContain("Switch to Beta");
    expect(container.textContent).toContain("Unmark");
  });

  it("the switch offer moves through the same pick path", () => {
    seedTwoProviders();
    openDropdown();
    click(buttonByText("These lyrics are wrong"));
    click(buttonByText("Switch to Beta"));

    expect(useLyricsStore.getState().activeProvider).toBe("Beta");
    expect(lyricsCache.get(TRACK_ID)?.userProvider).toBe("beta");
    // the mark itself is untouched by switching
    expect(lyricsCache.get(TRACK_ID)?.wrongProvider?.provider).toBe("alpha");
  });

  it("unmark clears the mark where it was made", () => {
    seedTwoProviders();
    // a mark recorded earlier (e.g. on a previous play) is read back
    // when the dropdown opens
    lyricsCache.markWrongProvider(TRACK_ID, "Alpha");
    openDropdown();
    expect(container.textContent).toContain("Marked as wrong");
    click(buttonByText("Unmark"));

    expect(lyricsCache.get(TRACK_ID)?.wrongProvider).toBeUndefined();
    expect(container.textContent).toContain("These lyrics are wrong");
    expect(container.textContent).not.toContain("Marked as wrong");
  });

  it("a single-candidate track shows no footer action", () => {
    seedStore([opt(alpha)], "Alpha");
    lyricsCache.set(TRACK_ID, alpha, [opt(alpha)]);
    render();
    // the provider button cannot open a dropdown for one source
    click(buttonByText("Alpha"));
    expect(container.textContent).not.toContain("These lyrics are wrong");
  });
});
