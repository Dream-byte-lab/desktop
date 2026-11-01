import { describe, expect, it } from "vitest";
import type { RaveDecision } from "./liveRave";
import { linkRecordId, statusUpdatesForDecisions } from "./partyHost";

describe("partyHost record linking", () => {
  it("fans a canonical decision out to every guest who asked", () => {
    const records = new Map<string, Set<string>>();
    linkRecordId(records, "guest-a-record", "canonical-1");
    linkRecordId(records, "guest-b-record", "canonical-1");
    linkRecordId(records, "guest-c-record", "canonical-2");

    const decisions: RaveDecision[] = [
      {
        requestId: "canonical-1",
        status: "scheduled",
        slotIndex: 0,
        reason: "Coming soon",
      },
      { requestId: "canonical-2", status: "waiting", reason: "Held" },
    ];
    const updates = statusUpdatesForDecisions(
      decisions,
      records,
      new Map([
        ["canonical-1", 300],
        ["canonical-2", 30],
      ]),
    );

    expect(updates).toEqual([
      { recordId: "guest-a-record", status: "coming soon" },
      { recordId: "guest-b-record", status: "coming soon" },
      { recordId: "guest-c-record", status: "received" },
    ]);
  });

  it("ignores decisions for requests it never linked", () => {
    const updates = statusUpdatesForDecisions(
      [{ requestId: "unknown", status: "waiting", reason: "" }],
      new Map(),
      new Map(),
    );
    expect(updates).toEqual([]);
  });
});
