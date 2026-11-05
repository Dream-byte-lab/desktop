import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Source pins for the DJ stack's height cap in AppFrame (Note 35:
// the stage's Back button dead in a normal window, alive in
// fullscreen). AppFrame has no render harness in this tree, so —
// following AppFrame.stageEscape.test.ts's precedent — the fix is
// pinned at the source.
//
// The mechanism these pins guard: the bottom container's DJ stack
// (stage + simple view + party panel) grows upward unbounded while
// main is flex-1 with an automatic minimum height of 0, so in a
// short window the stage's header rises into the floating header's
// band (absolute top-1.5, 50px tall, z-45 above the content row).
// That band is the header's window-drag surface, so clicks there
// never reach the stage's controls. The cap below reserves 210px
// of window height — shell padding and gaps, the 64px player bar,
// and 128px of main — which keeps the stage header below the band
// in both of the container's margin states (plain, and the
// -mt-[70px] backdrop pull-up). Shrinking the reserve re-opens the
// trap; these pins exist so that edit fails loudly here first.

function appFrameSource(): string {
  const fromCwd = path.resolve(
    process.cwd(),
    "src/features/navigation/ui/AppFrame.tsx",
  );
  if (existsSync(fromCwd)) return readFileSync(fromCwd, "utf8");
  return readFileSync(new URL("./AppFrame.tsx", import.meta.url), "utf8");
}

describe("AppFrame — the DJ stack's height cap (Note 35)", () => {
  const source = appFrameSource();

  const wrapStart = source.indexOf("data-dj-stack");
  const wrapEnd = source.indexOf("<MiniPlayer", wrapStart);
  const wrapped = source.slice(wrapStart, wrapEnd);

  it("wraps the DJ views in a capped, scrollable region", () => {
    expect(wrapStart).toBeGreaterThanOrEqual(0);
    expect(wrapped).toContain("overflow-y-auto");
    expect(wrapped).toContain("max-h-[max(140px,calc(100dvh-210px))]");
  });

  it("caps exactly the three DJ views — stage, simple, party", () => {
    expect(wrapped).toContain("<DjProView />");
    expect(wrapped).toContain("<DjSimpleView />");
    expect(wrapped).toContain("<DjPartyPanel />");
  });

  it("keeps the player bar outside the scroll region", () => {
    // MiniPlayer follows the wrapper's close: the bar is the one
    // surface that must never scroll away, and its popups anchor
    // to it, not to the capped stack.
    expect(wrapEnd).toBeGreaterThan(wrapStart);
    const between = source.slice(wrapStart, wrapEnd);
    expect(between).not.toContain("<MiniPlayer");
    expect(between.lastIndexOf("</div>")).toBeGreaterThan(
      between.indexOf("<DjPartyPanel />"),
    );
  });

  it("keeps the header band's geometry the fix is measured against", () => {
    // The floating header wrap: full-width, top-anchored, above
    // the content row. If this geometry changes, the 210px
    // reserve must be re-derived — this pin is the reminder.
    expect(source).toContain('className="absolute inset-x-1.5 top-1.5 z-[45]"');
  });
});
