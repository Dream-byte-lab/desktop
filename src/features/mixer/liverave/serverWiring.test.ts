// serverWiring.test.ts — the §8.3 kill-switch wiring, proven at
// the supply seam createDefaultSupply builds for the live
// session:
//
// - switch OFF (the default): the server source is never
//   consulted — a fetch that WOULD answer with a valid server
//   document is never even called — and the pair outcome is the
//   unwired engine's own local authoring, unchanged;
// - switch ON with a base URL configured: the server document is
//   fetched and used (source "server");
// - switch ON with no base URL: the server answers misses and
//   local authoring still serves, untouched.
//
// The pair path exercises the gate; createSupply's read path
// consults the server through the same serverUsable() gate.

import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYSIS_VERSION } from "./analyse";
import type { TrackFacts } from "./facts";
import {
  createBehaviourLog,
  createInMemoryBehaviourStore,
  type BehaviourLog,
} from "./memory";
import type { JoinRecipe } from "./recipe";
import { createDefaultSupply } from "./session";
import { useDjSettings } from "./settings";
import { createSupply } from "./supply";
import {
  clubA,
  clubB,
  distantA,
  distantB,
  dropA,
  dropB,
  folkA,
  folkB,
  popA,
  popB,
} from "./testFixtures";

const SENTINEL = { id: "server-sentinel" } as unknown as JoinRecipe;

/** A fetch that answers any pair lookup with a valid envelope. */
function serverFetch(a: TrackFacts, b: TrackFacts) {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith("/v1/pairs")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          kind: "linerave.pair-candidates",
          version: 1,
          pair: {
            aAudioHash: a.audioHash,
            bAudioHash: b.audioHash,
            analysisVersion: ANALYSIS_VERSION,
          },
          arcPosition: 0.5,
          candidates: [SENTINEL],
          rejected: [],
        }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function setServerSettings(enabled: boolean, baseUrl: string): void {
  useDjSettings.setState({
    serverMixingEnabled: enabled,
    serverBaseUrl: baseUrl,
  });
}

afterEach(() => {
  useDjSettings.getState().reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createDefaultSupply — the kill-switch wiring", () => {
  it("switch off: never consults the server; outcome is the unwired engine's", async () => {
    setServerSettings(false, "https://supply.example");
    const fetchSpy = serverFetch(clubA, clubB);
    vi.stubGlobal("fetch", fetchSpy);

    const wired = createDefaultSupply();
    const result = await wired.supplyPair(clubA, clubB, { arcPosition: 0 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result?.source).toBe("local");

    // The unwired supply (createSupply with no deps — the engine
    // as it shipped before this wiring) produces the same pair
    // outcome for the same pair: same candidates, same rejections.
    const unwired = createSupply();
    const plain = await unwired.supplyPair(clubA, clubB, { arcPosition: 0 });
    expect(plain?.candidates).toEqual(result?.candidates);
    expect(plain?.rejected).toEqual(result?.rejected);
  });

  it("switch on: the server document is fetched and used", async () => {
    setServerSettings(true, "https://supply.example");
    const fetchSpy = serverFetch(popA, popB);
    vi.stubGlobal("fetch", fetchSpy);

    const wired = createDefaultSupply();
    const result = await wired.supplyPair(popA, popB, { arcPosition: 0 });

    expect(fetchSpy).toHaveBeenCalled();
    expect(result?.source).toBe("server");
    expect(result?.candidates).toEqual([SENTINEL]);
    expect(result?.arcPosition).toBe(0.5);
  });

  it("switch on but no base URL: local authoring serves, fetch untouched", async () => {
    setServerSettings(true, "");
    const fetchSpy = serverFetch(dropA, dropB);
    vi.stubGlobal("fetch", fetchSpy);

    const wired = createDefaultSupply();
    const result = await wired.supplyPair(dropA, dropB, { arcPosition: 0 });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).not.toBeNull();
    expect(result?.source).toBe("local");
  });
});

// ---------------------------------------------------------------------
// Contribution through the same wiring: locally authored documents
// are offered to the shelf while the switch is on, counted in the
// behaviour record, and never offered while it is off.
// ---------------------------------------------------------------------

/**
 * A fetch that misses every lookup (POST /v1/pairs → 404) and
 * answers pair PUTs with the given status, so local authoring is
 * what serves — and its document is what gets contributed.
 */
function contributionFetch(putStatus: 201 | 409) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "PUT" && String(url).includes("/v1/pairs/")) {
      return putStatus === 201
        ? {
            ok: true,
            status: 201,
            json: async () => ({ stored: true, existed: false }),
          }
        : {
            ok: false,
            status: 409,
            json: async () => ({ error: "different document" }),
          };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

async function flushContributions(): Promise<void> {
  for (let i = 0; i < 15; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function putCalls(fetchSpy: ReturnType<typeof vi.fn>): unknown[][] {
  return fetchSpy.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
  );
}

describe("createDefaultSupply — contribution wiring", () => {
  it("switch off: a locally authored pair is never offered — no fetch, no record", async () => {
    setServerSettings(false, "https://supply.example");
    const fetchSpy = contributionFetch(201);
    vi.stubGlobal("fetch", fetchSpy);
    const log: BehaviourLog = createBehaviourLog(
      createInMemoryBehaviourStore(),
    );

    const wired = createDefaultSupply(log);
    const result = await wired.supplyPair(folkA, folkB, { arcPosition: 0 });
    await flushContributions();

    expect(result?.source).toBe("local");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.distribution().total).toBe(0);
  });

  it("switch on: the locally authored pair is PUT to its address and counted as contributed", async () => {
    setServerSettings(true, "https://supply.example");
    const fetchSpy = contributionFetch(201);
    vi.stubGlobal("fetch", fetchSpy);
    const log: BehaviourLog = createBehaviourLog(
      createInMemoryBehaviourStore(),
    );

    const wired = createDefaultSupply(log);
    const result = await wired.supplyPair(distantA, distantB, {
      arcPosition: 0,
    });
    await flushContributions();

    expect(result?.source).toBe("local");
    const puts = putCalls(fetchSpy);
    expect(puts).toHaveLength(1);
    expect(String(puts[0][0])).toBe(
      `https://supply.example/v1/pairs/${distantA.audioHash}/${distantB.audioHash}`,
    );
    expect(log.distribution().byReason).toEqual({ "supply-contributed": 1 });
    const [record] = log.getBehaviourLog();
    expect(record.family).toBeNull();
    expect(record.pairTrackIds).toEqual([
      distantA.audioHash,
      distantB.audioHash,
    ]);
  });

  it("switch on: a 409 from the shelf is counted as a contribution conflict", async () => {
    setServerSettings(true, "https://supply.example");
    const fetchSpy = contributionFetch(409);
    vi.stubGlobal("fetch", fetchSpy);
    const log: BehaviourLog = createBehaviourLog(
      createInMemoryBehaviourStore(),
    );

    const wired = createDefaultSupply(log);
    // The reverse direction is a different content address — a
    // fresh document for the local store, authored locally here.
    const result = await wired.supplyPair(folkB, folkA, { arcPosition: 0 });
    await flushContributions();

    expect(result?.source).toBe("local");
    expect(putCalls(fetchSpy)).toHaveLength(1);
    expect(log.distribution().byReason).toEqual({
      "supply-contribution-conflict": 1,
    });
  });
});
