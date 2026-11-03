import { beforeEach, describe, expect, it } from "vitest";
import {
  LYRICS_BIGGER_TEXT_SCALE,
  lyricsDisplayOptionsFor,
  useLyricsDisplayStore,
} from "./lyricsDisplayStore";

const DEFAULTS = {
  gaussianBlur: true,
  biggerText: false,
  highlightLyrics: true,
  textAlign: "center" as const,
};

describe("useLyricsDisplayStore (reference 27 preferences)", () => {
  beforeEach(() => {
    localStorage.clear();
    useLyricsDisplayStore.setState({ ...DEFAULTS });
  });

  it("defaults are the reference image composition: blur on, highlight on, centred, standard size", () => {
    const state = useLyricsDisplayStore.getState();
    expect(state.gaussianBlur).toBe(true);
    expect(state.biggerText).toBe(false);
    expect(state.highlightLyrics).toBe(true);
    expect(state.textAlign).toBe("center");
  });

  it("setters update the preferences", () => {
    const store = useLyricsDisplayStore.getState();
    store.setGaussianBlur(false);
    store.setBiggerText(true);
    store.setHighlightLyrics(false);
    store.setTextAlign("left");
    const state = useLyricsDisplayStore.getState();
    expect(state.gaussianBlur).toBe(false);
    expect(state.biggerText).toBe(true);
    expect(state.highlightLyrics).toBe(false);
    expect(state.textAlign).toBe("left");
  });

  it("persists under the versioned key, preferences only", () => {
    useLyricsDisplayStore.getState().setGaussianBlur(false);
    useLyricsDisplayStore.getState().setTextAlign("left");
    const raw = localStorage.getItem("linerave_lyrics_display_v1");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as {
      state: Record<string, unknown>;
    };
    expect(parsed.state.gaussianBlur).toBe(false);
    expect(parsed.state.textAlign).toBe("left");
    expect(parsed.state.highlightLyrics).toBe(true);
    // Actions are never persisted.
    expect(parsed.state.setGaussianBlur).toBeUndefined();
  });

  it("maps preferences onto renderer display options", () => {
    expect(
      lyricsDisplayOptionsFor({
        textAlign: "center",
        highlightLyrics: true,
        biggerText: false,
      }),
    ).toEqual({ align: "center", highlight: true, textScale: 1 });
    expect(
      lyricsDisplayOptionsFor({
        textAlign: "left",
        highlightLyrics: false,
        biggerText: true,
      }),
    ).toEqual({
      align: "start",
      highlight: false,
      textScale: LYRICS_BIGGER_TEXT_SCALE,
    });
    // Bigger text is a real step, not a token gesture.
    expect(LYRICS_BIGGER_TEXT_SCALE).toBeGreaterThanOrEqual(1.25);
  });
});
