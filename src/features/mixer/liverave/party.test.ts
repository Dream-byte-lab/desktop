// party.test.ts — the guest-request scheduler: dedupe, absolute
// refusals, fit thresholds, and the never-back-to-back rule.

import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { createPartyScheduler, type PartyEvaluationContext } from "./party";

function track(id: string): Track {
  return {
    id,
    title: `Track ${id}`,
    artists: "Artist",
    coverUrl: "",
    durationMs: 180_000,
    playCount: 0,
  };
}

function ctx(
  overrides: Partial<PartyEvaluationContext> = {},
): PartyEvaluationContext {
  return {
    playedIds: new Set<string>(),
    doNotPlayIds: new Set<string>(),
    fitOf: () => 0.9,
    ...overrides,
  };
}

describe("party requests — book-keeping", () => {
  it("dedupes by track and counts votes by distinct guests", () => {
    const party = createPartyScheduler({ now: () => 1000 });
    const a = track("a");
    const first = party.submit(a, "guest-1");
    const again = party.submit(a, "guest-1");
    const second = party.submit(a, "guest-2");
    expect(again.id).toBe(first.id);
    expect(again.votes).toBe(1); // same guest twice is one vote
    expect(second.votes).toBe(2);
    expect(party.allRequests()).toHaveLength(1);
  });

  it("a new request waits until it is judged", () => {
    const party = createPartyScheduler();
    const request = party.submit(track("a"));
    expect(request.status).toBe("waiting");
    expect(party.guestStatus("a")).toBe("waiting");
    expect(party.guestStatus("never-asked")).toBeNull();
  });
});

describe("party evaluation — refusals and fits", () => {
  it("do-not-play refuses absolutely, even a previously scheduled request", () => {
    const party = createPartyScheduler();
    party.submit(track("a"), "g1");
    party.evaluate(ctx());
    expect(party.guestStatus("a")).toBe("scheduled");
    party.evaluate(ctx({ doNotPlayIds: new Set(["a"]) }));
    expect(party.guestStatus("a")).toBe("not-tonight");
    // And no later fit, however strong, resurrects it while the
    // do-not-play entry stands.
    party.evaluate(ctx({ doNotPlayIds: new Set(["a"]), fitOf: () => 1 }));
    expect(party.guestStatus("a")).toBe("not-tonight");
  });

  it("already-played refuses absolutely", () => {
    const party = createPartyScheduler();
    party.submit(track("a"), "g1");
    party.evaluate(ctx({ playedIds: new Set(["a"]) }));
    expect(party.guestStatus("a")).toBe("not-tonight");
  });

  it("an unjudgeable fit waits; a weak fit refuses; a middling fit waits; a strong fit schedules", () => {
    const party = createPartyScheduler();
    party.submit(track("unknown"), "g");
    party.submit(track("weak"), "g");
    party.submit(track("mid"), "g");
    party.submit(track("strong"), "g");
    party.evaluate(
      ctx({
        fitOf: (t) =>
          t.id === "unknown"
            ? null
            : t.id === "weak"
              ? 0.1
              : t.id === "mid"
                ? 0.4
                : 0.9,
      }),
    );
    expect(party.guestStatus("unknown")).toBe("waiting");
    expect(party.guestStatus("weak")).toBe("not-tonight");
    expect(party.guestStatus("mid")).toBe("waiting");
    expect(party.guestStatus("strong")).toBe("scheduled");
  });

  it("a fit-refused request can be re-judged when the arc moves", () => {
    const party = createPartyScheduler();
    party.submit(track("a"), "g");
    party.evaluate(ctx({ fitOf: () => 0.1 }));
    expect(party.guestStatus("a")).toBe("not-tonight");
    party.evaluate(ctx({ fitOf: () => 0.95 }));
    expect(party.guestStatus("a")).toBe("scheduled");
  });

  it("openRequests lists scheduled and waiting, never refused", () => {
    const party = createPartyScheduler();
    party.submit(track("a"), "g");
    party.submit(track("b"), "g");
    party.evaluate(ctx({ fitOf: (t) => (t.id === "a" ? 0.9 : 0.1) }));
    expect(party.openRequests().map((r) => r.track.id)).toEqual(["a"]);
  });
});

describe("party insertion — never two guest tracks back-to-back", () => {
  function scheduledParty(
    ids: string[],
  ): ReturnType<typeof createPartyScheduler> {
    const party = createPartyScheduler();
    for (const id of ids) party.submit(track(id), `guest-${id}`);
    party.evaluate(ctx());
    return party;
  }

  it("inserts guests between host tracks", () => {
    const party = scheduledParty(["g1", "g2"]);
    const order = party
      .insertScheduled([track("h1"), track("h2"), track("h3")])
      .map((t) => t.id);
    // g1 follows h1 (h2 separates it from g2); order keeps hosts in place.
    expect(order[0]).toBe("h1");
    expect(order).toContain("g1");
    expect(order).toContain("g2");
    for (let i = 0; i + 1 < order.length; i += 1) {
      const pair = [order[i], order[i + 1]];
      expect(pair.every((id) => id.startsWith("g"))).toBe(false);
    }
  });

  it("a guest that cannot be placed without touching another guest waits", () => {
    const party = scheduledParty(["g1", "g2", "g3"]);
    const order = party.insertScheduled([track("h1")]).map((t) => t.id);
    // One host track can separate at most... the trailing slot
    // takes one guest; the rest honestly wait.
    expect(order).toEqual(["h1", "g1"]);
    expect(party.guestStatus("g1")).toBe("scheduled");
    expect(party.guestStatus("g2")).toBe("waiting");
    expect(party.guestStatus("g3")).toBe("waiting");
  });

  it("higher-voted guests are placed first", () => {
    const party = createPartyScheduler();
    party.submit(track("low"), "g1");
    party.submit(track("high"), "g1");
    party.submit(track("high"), "g2");
    party.submit(track("high"), "g3");
    party.evaluate(ctx());
    const order = party.insertScheduled([track("h1")]).map((t) => t.id);
    expect(order).toEqual(["h1", "high"]);
    expect(party.guestStatus("low")).toBe("waiting");
  });

  it("re-insertion is stable: already-placed guests are not duplicated", () => {
    const party = scheduledParty(["g1"]);
    const once = party.insertScheduled([track("h1"), track("h2")]);
    const twice = party.insertScheduled(once);
    expect(twice.map((t) => t.id)).toEqual(once.map((t) => t.id));
    expect(twice.filter((t) => t.id === "g1")).toHaveLength(1);
  });
});
