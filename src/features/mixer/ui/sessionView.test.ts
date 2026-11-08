// sessionView.test.ts — the receipts label (wave item 4).

import { describe, expect, it } from "vitest";
import { provenanceLabel } from "./sessionView";

describe("provenanceLabel", () => {
  it("renders source, slate position, rung and crates version", () => {
    expect(
      provenanceLabel({
        provenance: {
          source: "planner",
          slatePosition: 2,
          ladderRung: 1,
          cratesVersion: "crates-v1",
        },
      }),
    ).toBe("planner · slate #2 · rung 1 · crates-v1");
  });

  it("renders a personality source and a ladder-rung source verbatim", () => {
    expect(
      provenanceLabel({
        provenance: {
          source: "personality:battle",
          slatePosition: 1,
          ladderRung: 2,
          cratesVersion: "crates-v1",
        },
      }),
    ).toBe("personality:battle · slate #1 · rung 2 · crates-v1");
    expect(
      provenanceLabel({
        provenance: {
          source: "ladder-rung:4",
          slatePosition: null,
          ladderRung: 4,
          cratesVersion: "crates-v1",
        },
      }),
    ).toBe("ladder-rung:4 · rung 4 · crates-v1");
  });

  it("renders nothing for pre-wave records (no stamp, nothing invented)", () => {
    expect(provenanceLabel({ provenance: undefined })).toBe("");
    expect(provenanceLabel({})).toBe("");
  });
});
