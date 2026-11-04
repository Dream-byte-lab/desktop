// Harvest Wave 4, Item 1 — the romanization preference on the
// lyrics-display store: default OFF (the user's romanization
// posture), its setter, its persisted round-trip, and its mapping
// into the renderer's display options. The pre-existing
// lyricsDisplayStore.test.ts pins the other four preferences and
// the three-primitive mapping; this file pins only the new field.

import { beforeEach, describe, expect, it } from "vitest";
import {
  lyricsDisplayOptionsFor,
  useLyricsDisplayStore,
} from "./lyricsDisplayStore";

const DEFAULTS = {
  gaussianBlur: true,
  biggerText: false,
  highlightLyrics: true,
  textAlign: "center" as const,
  romanization: false,
};

describe("useLyricsDisplayStore romanization preference", () => {
  beforeEach(() => {
    localStorage.clear();
    useLyricsDisplayStore.setState({ ...DEFAULTS });
  });

  it("defaults OFF", () => {
    expect(useLyricsDisplayStore.getState().romanization).toBe(false);
  });

  it("the setter updates the preference", () => {
    useLyricsDisplayStore.getState().setRomanization(true);
    expect(useLyricsDisplayStore.getState().romanization).toBe(true);
    useLyricsDisplayStore.getState().setRomanization(false);
    expect(useLyricsDisplayStore.getState().romanization).toBe(false);
  });

  it("persists under the versioned key alongside the other preferences", () => {
    useLyricsDisplayStore.getState().setRomanization(true);
    const raw = localStorage.getItem("linerave_lyrics_display_v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as {
      state: Record<string, unknown>;
    };
    expect(parsed.state.romanization).toBe(true);
    // The setter itself is never persisted.
    expect(parsed.state.setRomanization).toBeUndefined();
  });

  it("maps into the renderer display options when supplied", () => {
    const base = {
      textAlign: "center" as const,
      highlightLyrics: true,
      biggerText: false,
    };
    expect(lyricsDisplayOptionsFor({ ...base, romanization: true })).toEqual({
      align: "center",
      highlight: true,
      textScale: 1,
      romanization: true,
    });
    expect(lyricsDisplayOptionsFor({ ...base, romanization: false })).toEqual({
      align: "center",
      highlight: true,
      textScale: 1,
      romanization: false,
    });
  });

  it("an omitted preference leaves the field out (partial pushes stay partial)", () => {
    const options = lyricsDisplayOptionsFor({
      textAlign: "center",
      highlightLyrics: true,
      biggerText: false,
    });
    expect("romanization" in options).toBe(false);
  });
});
