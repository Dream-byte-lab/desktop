// serverContract.test.ts — the seam against the REAL local
// Worker (server-cloudflare-work's linerave-supply, run locally
// in Miniflare): contribute → search finds it → fetch returns it
// byte-exact.
//
// This suite is ENV-GATED: it runs only when LINERAVE_SUPPLY_URL
// and LINERAVE_SUPPLY_TOKEN point at a locally running Worker
// (see investigation/server-contribution-report.md for the
// harness). In the ordinary battery it skips — a clean checkout
// has no server to talk to, and a skipped contract is honest
// where a fake one would not be. It never touches any deployed
// service: the URL is expected to be a loopback Miniflare
// address with a throwaway token, and every document it shelves
// is deleted again by the test that shelved it.

import { describe, expect, it } from "vitest";
import { ANALYSIS_VERSION, audioFingerprint } from "./analyse";
import type { TrackRead } from "./facts";
import type { JoinRecipe } from "./recipe";
import {
  buildPairCandidatesEnvelope,
  buildTrackReadEnvelope,
  createServerClient,
  createSupply,
  type PairDocument,
  type ServerClient,
  type SupplyStorage,
} from "./supply";

const SUPPLY_URL = (process.env.LINERAVE_SUPPLY_URL ?? "").replace(/\/+$/, "");
const SUPPLY_TOKEN = process.env.LINERAVE_SUPPLY_TOKEN ?? "";
const LIVE = SUPPLY_URL.length > 0 && SUPPLY_TOKEN.length > 0;

const RUN = `contract-${Date.now().toString(36)}`;
const SAMPLE_RATE = 22050;

function makeRead(audioHash: string): TrackRead {
  return {
    audioHash,
    analysisVersion: ANALYSIS_VERSION,
    depth: "deep",
    durationSec: 120,
    bpm: 124,
    tempoConfidence: 0.8,
    grid: { beatsMs: [], downbeatsMs: [], beatsPerBar: 4, confidence: 0.8 },
    key: null,
    sections: [],
    energyCurvePerSec: [],
    energyContour: [],
    vocalActivity: [],
    drops: [],
    loudnessRms: 0.2,
  };
}

function client(): ServerClient {
  return createServerClient(SUPPLY_URL, fetch, { token: SUPPLY_TOKEN });
}

async function search(params: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await fetch(`${SUPPLY_URL}/v1/search?${params}`, {
    headers: { authorization: `Bearer ${SUPPLY_TOKEN}` },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

async function rawGet(path: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`${SUPPLY_URL}${path}`, {
    headers: { authorization: `Bearer ${SUPPLY_TOKEN}` },
  });
  return { status: response.status, text: await response.text() };
}

async function rawDelete(path: string): Promise<void> {
  await fetch(`${SUPPLY_URL}${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${SUPPLY_TOKEN}` },
  });
}

describe.skipIf(!LIVE)("contract — the local supply Worker", () => {
  it("contribute → search finds it → fetch returns it byte-exact (track read)", async () => {
    const hash = `lr1.${RUN}-read`;
    const read = makeRead(hash);
    const api = client();

    await expect(api.uploadTrackRead(read)).resolves.toBe("stored");
    // Write-once: the identical document again is a success-no-op.
    await expect(api.uploadTrackRead(read)).resolves.toBe("already-shelved");

    // Search finds the address, from metadata only.
    const found = await search(`hash=${encodeURIComponent(hash.slice(0, 20))}`);
    expect(found.status).toBe(200);
    const matches = found.body.matches as Array<Record<string, unknown>>;
    expect(matches).toContainEqual(
      expect.objectContaining({ audioHash: hash, depth: "deep" }),
    );

    // Byte-exact: the shelf returns the very bytes contributed.
    const raw = await rawGet(`/v1/tracks/${encodeURIComponent(hash)}`);
    expect(raw.status).toBe(200);
    expect(raw.text).toBe(JSON.stringify(buildTrackReadEnvelope(read)));
    await expect(api.fetchTrackRead(hash)).resolves.toEqual(read);

    // Different bytes at the same address: a conflict, and the
    // first document stays.
    const tampered = { ...read, bpm: 125 };
    await expect(api.uploadTrackRead(tampered)).resolves.toBe("conflict");
    const after = await rawGet(`/v1/tracks/${encodeURIComponent(hash)}`);
    expect(after.text).toBe(JSON.stringify(buildTrackReadEnvelope(read)));

    await rawDelete(`/v1/tracks/${encodeURIComponent(hash)}`);
    const gone = await search(`hash=${encodeURIComponent(hash)}`);
    expect(gone.body.matches).toEqual([]);
    await expect(api.fetchTrackRead(hash)).resolves.toBeNull();
  }, 20000);

  it("contribute → search finds it (either order) → fetch returns it (pair document)", async () => {
    const aHash = `lr1.${RUN}-a`;
    const bHash = `lr1.${RUN}-b`;
    const doc: PairDocument = {
      aHash,
      bHash,
      arcPosition: 0.4,
      candidates: [{ id: "join-1" } as unknown as JoinRecipe],
      rejected: [{ family: "blend", reason: "no" }],
    };
    const api = client();

    await expect(api.uploadPairCandidates(doc)).resolves.toBe("stored");
    await expect(api.uploadPairCandidates(doc)).resolves.toBe(
      "already-shelved",
    );

    // The shelf search accepts the pair in either order and
    // names the address the document actually lives at.
    const reversed = await search(
      `pair=${encodeURIComponent(`${bHash}:${aHash}`)}`,
    );
    expect(reversed.status).toBe(200);
    expect(reversed.body.found).toBe(true);
    expect(reversed.body.document).toEqual(
      expect.objectContaining({ aAudioHash: aHash, bAudioHash: bHash }),
    );

    const got = await api.fetchPairCandidates(aHash, bHash, 0.4);
    expect(got?.candidates).toEqual(doc.candidates);
    expect(got?.rejected).toEqual(doc.rejected);
    expect(got?.arcPosition).toBe(0.4);

    await rawDelete(
      `/v1/pairs/${encodeURIComponent(aHash)}/${encodeURIComponent(bHash)}`,
    );
    const gone = await search(
      `pair=${encodeURIComponent(`${aHash}:${bHash}`)}`,
    );
    expect(gone.body.found).toBe(false);
  }, 20000);

  it("the supply contributes its own locally computed read, end to end", async () => {
    const samples = new Float32Array(4096);
    for (let i = 0; i < samples.length; i += 1) {
      samples[i] = 0.4 * Math.sin((2 * Math.PI * i) / 32);
    }
    const hash = audioFingerprint(samples, SAMPLE_RATE);
    const read = makeRead(hash);
    const storage: SupplyStorage = {
      getRead: async () => null,
      putRead: async () => {},
      getPairSet: async () => null,
      putPairSet: async () => {},
    };
    const supply = createSupply({
      storage,
      server: client(),
      runner: { analyse: async () => read },
      isServerEnabled: () => true,
    });

    const got = await supply.supplyRead({
      samples,
      sampleRate: SAMPLE_RATE,
      depth: "deep",
    });
    expect(got).toEqual({ read, source: "local" });

    // The contribution is background: poll the shelf's search
    // until the read's address appears.
    let found = false;
    for (let attempt = 0; attempt < 50 && !found; attempt += 1) {
      const result = await search(
        `hash=${encodeURIComponent(hash.slice(0, 24))}`,
      );
      const matches = result.body.matches as Array<Record<string, unknown>>;
      found = matches.some((match) => match.audioHash === hash);
      if (!found) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    expect(found).toBe(true);
    await expect(client().fetchTrackRead(hash)).resolves.toEqual(read);

    await rawDelete(`/v1/tracks/${encodeURIComponent(hash)}`);
  }, 20000);

  it("the pair envelope bytes round-trip through the shelf untouched", async () => {
    const aHash = `lr1.${RUN}-bytes-a`;
    const bHash = `lr1.${RUN}-bytes-b`;
    const doc: PairDocument = {
      aHash,
      bHash,
      arcPosition: 0.25,
      candidates: [{ id: "join-9" } as unknown as JoinRecipe],
      rejected: [],
    };
    const api = client();
    await expect(api.uploadPairCandidates(doc)).resolves.toBe("stored");

    // The pair lookup (POST) returns the stored document bytes.
    const response = await fetch(`${SUPPLY_URL}/v1/pairs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SUPPLY_TOKEN}`,
      },
      body: JSON.stringify({ a: aHash, b: bHash, arcPosition: 0.25 }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      JSON.stringify(buildPairCandidatesEnvelope(doc)),
    );

    await rawDelete(
      `/v1/pairs/${encodeURIComponent(aHash)}/${encodeURIComponent(bHash)}`,
    );
  }, 20000);
});
