import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Source pins for the DJ stage's Escape slot in AppFrame
// (Note 26, the AppFrame-side wiring the stage-engine seams
// report named as owed). AppFrame itself has no render harness
// in this tree, so — following the stage seams tests' precedent
// — the wiring is pinned at the source: the frame reads the
// stage's open state from the mixer store and hands the shortcut
// chain the open/close pair. The chain's behaviour (ranking,
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

describe("AppFrame — the DJ stage's Escape slot (Note 26)", () => {
  const source = appFrameSource();

  it("reads the stage's open state from the mixer mode store", () => {
    expect(source).toContain('from "@/features/mixer/store/djModeStore"');
    expect(source).toContain("state.proOpen");
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
