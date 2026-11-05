import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Wiring seams for the player bar's pop-out button, read off
// the source in the tree's seam idiom — MiniPlayer itself is
// engine-driven end to end, so its button wiring is what
// these pins hold. What a press DOES (which bridge calls it
// makes) is pinned by popOutOverlay's own unit tests in the
// overlay feature.

function miniPlayerSource(): string {
  const fromCwd = path.resolve(
    process.cwd(),
    "src/features/player/ui/MiniPlayer.tsx",
  );
  if (existsSync(fromCwd)) return readFileSync(fromCwd, "utf8");
  return readFileSync(new URL("./MiniPlayer.tsx", import.meta.url), "utf8");
}

function buttonSlice(source: string, labelKey: string): string {
  const at = source.indexOf(`t("${labelKey}")`);
  if (at < 0) throw new Error(`No button labelled ${labelKey}`);
  const end = source.indexOf("</button>", at);
  if (end < 0) throw new Error("Unterminated button");
  return source.slice(at, end);
}

describe("MiniPlayer pop-out button", () => {
  it("raises the overlay and no longer opens the fullscreen player", () => {
    const button = buttonSlice(miniPlayerSource(), "player.pop_out");
    expect(button).toContain("popOutOverlay()");
    expect(button).not.toContain("onFullscreenOpen");
  });

  it("wears the pop-out label and glyph, not the open-player ones", () => {
    const source = miniPlayerSource();
    expect(source).not.toContain("player.open_player");
    expect(source).not.toContain("MaximizeSquare3");
    expect(source).toContain("SquareArrowRightUp");
    expect(source).toContain('from "@/features/overlay"');
  });

  it("keeps the fullscreen player's other doors: lyrics, cover, title", () => {
    const source = miniPlayerSource();
    // The lyrics button still lands the player on its lyrics view.
    const lyrics = buttonSlice(source, "player.lyrics_view.open");
    expect(lyrics).toContain("requestLyricsViewOpen()");
    expect(lyrics).toContain("onFullscreenOpen");
    // And the prop still reaches the cover/title presses as well:
    // the fullscreen handler survives in several places, not none.
    const opens = source.match(/onFullscreenOpen/g) ?? [];
    expect(opens.length).toBeGreaterThanOrEqual(4);
  });
});
