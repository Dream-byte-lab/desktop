import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Source pins for the Booth's Escape slot in AppFrame
// (Note 26, carried onto the new DJ interface). AppFrame itself
// has no render harness in this tree, so — following the stage
// seams tests' precedent — the wiring is pinned at the source:
// the frame reads the Booth's open state from the new DJ state
// store (liverave/state) and hands the shortcut chain the
// open/close pair. The chain's behaviour (ranking,
// no-double-act) is pinned behaviourally in
// ../hooks/useGlobalShortcuts.test.tsx.

function appFrameSource(): string {
  const fromCwd = path.resolve(
    process.cwd(),
    "src/features/navigation/ui/AppFrame.tsx",
  );
  if (existsSync(fromCwd)) return readFileSync(fromCwd, "utf8");
  return readFileSync(new URL("./AppFrame.tsx", import.meta.url), "utf8");
}

describe("AppFrame — the Booth's Escape slot (Note 26)", () => {
  const source = appFrameSource();

  it("reads the Booth's open state from the new DJ state store", () => {
    expect(source).toContain('from "@/features/mixer/liverave/state"');
    expect(source).toContain("state.proOpen");
    // No trace of the old store may remain in the frame.
    expect(source).not.toContain("mixer/store/djModeStore");
    expect(source).not.toContain("mixer/engine/");
  });

  it("mounts the new DJ surfaces in the capped DJ region (Note 35)", () => {
    expect(source).toContain('from "@/features/mixer/ui/PerformanceRibbon"');
    expect(source).toContain('from "@/features/mixer/ui/Booth"');
    // The capped scroll region: max-h + overflow around the mounts,
    // so the header band can never cover the surfaces' controls.
    const regionStart = source.indexOf("max-h-[72vh]");
    expect(regionStart).toBeGreaterThanOrEqual(0);
    const region = source.slice(
      regionStart,
      source.indexOf("</div>", regionStart),
    );
    expect(region).toContain("overflow-y-auto");
    expect(region).toContain("<PerformanceRibbon />");
    expect(region).toContain("<Booth />");
    // The old surfaces are gone from the frame.
    expect(source).not.toContain("DjSimpleView");
    expect(source).not.toContain("DjProView");
    expect(source).not.toContain("DjPartyPanel");
  });

  it("hands the shortcut chain the stageOpen / closeStage pair", () => {
    const callStart = source.indexOf("useGlobalShortcuts({");
    expect(callStart).toBeGreaterThanOrEqual(0);
    const call = source.slice(callStart, source.indexOf("});", callStart));
    expect(call).toContain("stageOpen");
    expect(call).toContain("closeStage");
    // The stage slot is passed alongside — not instead of — the
    // fallback it outranks.
    expect(call).toContain("onEscapeFallback: handleEscapeFallback");
  });

  it("closeStage is a view act only: it writes proOpen false", () => {
    expect(source).toContain("setProOpen(false)");
  });
});
