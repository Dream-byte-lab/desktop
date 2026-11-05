// supply.ts — the one seam, three sources (design §8.1, Wave 2C).
//
// AnalysisSupply and PairSupply sit in front of every read / pair
// document the session consumes. Sources are consulted IN ORDER:
//   1. local storage.ts (fingerprint + ANALYSIS_VERSION gated there)
//   2. the mixing server (kill-switch gated, §8.3) — hits are
//      written through to local storage before use
//   3. local compute — the analysis worker runner for reads, the
//      local authors for pairs — results are stored locally in the
//      same document shape a server would have returned
// Every failure degrades to the next source; total failure is null,
// never a throw to callers. Pair documents are authored under
// NEUTRAL (identity) shaping (§8.1): suitability is never baked in —
// the session re-weighs the raw evidence under tonight's shaping.
//
// CONTRIBUTION (the seam's return path): a document LOCAL COMPUTE
// just produced is new to the world, so while the kill switch is
// on it is also offered to the server's shelf — in the background,
// after the supply result has been decided, never awaited, never
// allowed to delay or change it. The shelf is write-once: an
// identical document already there is a success-no-op, and
// different bytes at the same address are a conflict the supply
// surfaces as an outcome (via SupplyDeps.onContribution) — never
// overwritten, never retried. Cache hits are already local and
// server hits are already shelved, so only local compute
// contributes.
//
// Identity for reads is (audioHash, ANALYSIS_VERSION, depth); for
// pairs it is the ordered (aHash, bHash, ANALYSIS_VERSION) key the
// storage layer builds. A pair with a null audio hash on either side
// cannot be keyed, so it goes straight to the local author and is
// never cached or sent to the server.
//
// COORDINATOR RULING (§8.1 note, Wave 2C brief): a pair document
// records the arcPosition it was authored at. Consumers use the
// evidence as authored — bounded, recorded staleness — so a cache
// or server hit returns the DOCUMENT's arcPosition, not the
// caller's requested one.

import { ANALYSIS_VERSION, audioFingerprint } from "./analyse";
import { analysisRunner, type AnalysisRunner } from "./analysisRunner";
import type { AnalysisDepth, TrackFacts, TrackRead } from "./facts";
import type { JoinRecipe } from "./recipe";
import { NEUTRAL_SHAPING, type Shaping } from "./shaping";
import {
  getPairSet,
  getRead,
  pairStoreKey,
  putPairSet,
  putRead,
  readStoreKey,
  type StoredPairSet,
} from "./storage";

// ---------------------------------------------------------------------
// Pair document — the payload stored in the pairSets store
// ---------------------------------------------------------------------

export interface RejectedCandidateNote {
  family: string;
  reason: string;
}

export interface PairDocument {
  /** Outgoing track's audio hash; null only on uncached local docs. */
  aHash: string | null;
  /** Incoming track's audio hash; null only on uncached local docs. */
  bHash: string | null;
  /** The arc position this document was authored at (recorded). */
  arcPosition: number;
  candidates: JoinRecipe[];
  rejected: RejectedCandidateNote[];
}

// ---------------------------------------------------------------------
// Dependency shapes (all injectable; defaults are the real modules)
// ---------------------------------------------------------------------

/** The slice of storage.ts supply relies on (its module functions). */
export interface SupplyStorage {
  getRead(audioHash: string, depth: AnalysisDepth): Promise<TrackRead | null>;
  putRead(read: TrackRead): Promise<void>;
  getPairSet<T>(aHash: string, bHash: string): Promise<StoredPairSet<T> | null>;
  putPairSet<T>(aHash: string, bHash: string, pairSet: T): Promise<void>;
}

/** The slice of the analysis runner supply relies on. */
export type SupplyRunner = Pick<AnalysisRunner, "analyse">;

/**
 * The author function: the briefed authors.ts signature. Declared
 * structurally here so the default implementation can stay a lazy
 * dynamic import (authors.ts is only loaded when a pair actually
 * needs local authoring).
 */
export type AuthorCandidatesFn = (
  factsA: TrackFacts,
  factsB: TrackFacts,
  ctx: { arcPosition: number; shaping: Shaping },
) => { candidates: JoinRecipe[]; rejected: RejectedCandidateNote[] };

/**
 * The outcome of one contribution attempt, in the shelf's own
 * terms: "stored" — the document now sits at its address because
 * of this PUT; "already-shelved" — the address already held these
 * exact bytes (a success-no-op; the shelf is write-once);
 * "conflict" — the address holds DIFFERENT bytes (409): the first
 * document stays, ours was not written, and the caller hears
 * about it as a fact, never as something to retry away;
 * "failed" — the document was not offered or not accepted
 * (invalid document, no server, network failure, refusal).
 */
export type ContributionStatus =
  "stored" | "already-shelved" | "conflict" | "failed";

/**
 * One settled contribution, reported through
 * SupplyDeps.onContribution. The address is the storage layer's
 * own key shape (readStoreKey / pairStoreKey), so an outcome can
 * be matched against the local store and the server's shelf
 * without translation.
 */
export type ContributionOutcome =
  | {
      kind: "read";
      status: ContributionStatus;
      audioHash: string;
      address: string;
    }
  | {
      kind: "pair";
      status: ContributionStatus;
      aHash: string;
      bHash: string;
      address: string;
    };

/** The mixing-server client (see createServerClient). Never throws. */
export interface ServerClient {
  fetchTrackRead(audioHash: string): Promise<TrackRead | null>;
  fetchPairCandidates(
    aHash: string,
    bHash: string,
    arcPosition: number,
  ): Promise<{
    candidates: JoinRecipe[];
    rejected: RejectedCandidateNote[];
    arcPosition: number;
  } | null>;
  /**
   * Contribute a locally computed read (PUT /v1/tracks/:audioHash,
   * in the same linerave.track-read v1 envelope the fetch side
   * validates). Resolves a ContributionStatus; never throws.
   */
  uploadTrackRead(read: TrackRead): Promise<ContributionStatus>;
  /**
   * Contribute a locally authored pair document
   * (PUT /v1/pairs/:aHash/:bHash, in the same
   * linerave.pair-candidates v1 envelope the fetch side
   * validates). A document with a null hash on either side has
   * no content address and is "failed" without a request.
   * Resolves a ContributionStatus; never throws.
   */
  uploadPairCandidates(doc: PairDocument): Promise<ContributionStatus>;
}

export interface SupplyDeps {
  storage?: SupplyStorage;
  runner?: SupplyRunner;
  author?: AuthorCandidatesFn;
  server?: ServerClient | null;
  /**
   * The §8.3 kill switch. Default: () => false — server mixing is
   * OFF until settings wiring supplies a live gate (design §8.3:
   * default OFF until hosting exists).
   */
  isServerEnabled?: () => boolean;
  /**
   * Contribution outcome sink: called once per background
   * contribution as it settles (stored / already-shelved /
   * conflict / failed). Fire-and-forget from the supply's side —
   * a throwing sink is swallowed. Default: none (outcomes are
   * simply not recorded).
   */
  onContribution?: (outcome: ContributionOutcome) => void;
}

// ---------------------------------------------------------------------
// Supply result shapes
// ---------------------------------------------------------------------

export type SupplySource = "cache" | "server" | "local";

export interface SupplyReadResult {
  read: TrackRead;
  source: SupplySource;
}

export interface SupplyPairResult {
  candidates: JoinRecipe[];
  rejected: RejectedCandidateNote[];
  source: SupplySource;
  /** The arcPosition the returned document was authored at. */
  arcPosition: number;
}

export interface AnalysisSupply {
  supplyRead(request: {
    samples: Float32Array;
    sampleRate: number;
    depth: AnalysisDepth;
  }): Promise<SupplyReadResult | null>;
}

export interface PairSupply {
  supplyPair(
    factsA: TrackFacts,
    factsB: TrackFacts,
    options: { arcPosition: number },
  ): Promise<SupplyPairResult | null>;
}

export interface Supply extends AnalysisSupply, PairSupply {}

// ---------------------------------------------------------------------
// Server client — the NEW envelope shapes, validated, never throwing
// ---------------------------------------------------------------------

export const SERVER_REQUEST_TIMEOUT_MS = 4000;

type FetchImpl = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fetchJson(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response || !response.ok) return null;
    return await response.json();
  } catch {
    // Network error, timeout/abort, or a non-JSON body: a miss.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The upload counterpart of fetchJson: contributions need the
 * HTTP STATUS (a 409 is information, not a miss), so this returns
 * status + leniently parsed body, or null on network failure /
 * timeout. Same abort discipline as the fetch side.
 */
async function sendForStatus(
  fetchImpl: FetchImpl,
  url: string,
  init: RequestInit,
): Promise<{ status: number; body: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    if (!response) return null;
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A status with no parseable body still maps by status.
      body = null;
    }
    return { status: response.status, body };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Map an upload response onto the shelf's outcome vocabulary.
 * The server answers 201 for a fresh store and 200 with
 * { existed: true } for an identical re-PUT; both are landings,
 * told apart because "the shelf already had it" and "we put it
 * there" are different facts in the record.
 */
function contributionStatusOf(
  result: { status: number; body: unknown } | null,
): ContributionStatus {
  if (!result) return "failed";
  if (result.status === 409) return "conflict";
  if (result.status === 200 || result.status === 201) {
    if (isRecord(result.body) && result.body.existed === true) {
      return "already-shelved";
    }
    return "stored";
  }
  return "failed";
}

/**
 * The linerave.track-read v1 envelope, built exactly as the
 * fetch side validates it (and as the server re-validates it at
 * the door). Exported so tests — including the contract test
 * against the local Worker — serialise through the same builder
 * the client sends with, byte for byte.
 */
export function buildTrackReadEnvelope(read: TrackRead): {
  kind: string;
  version: number;
  audioHash: string;
  analysisVersion: number;
  depth: AnalysisDepth;
  read: TrackRead;
} {
  return {
    kind: "linerave.track-read",
    version: 1,
    audioHash: read.audioHash,
    analysisVersion: ANALYSIS_VERSION,
    depth: read.depth,
    read,
  };
}

/**
 * The linerave.pair-candidates v1 envelope, the mirror of the
 * fetch side's validated shape. Non-finite arcPositions and a
 * non-array rejected list are normalised the way the fetch side
 * tolerates them (finite fallback / empty list) — candidates
 * themselves are never normalised: a document without a
 * candidates array is not uploadable at all.
 */
export function buildPairCandidatesEnvelope(doc: PairDocument): {
  kind: string;
  version: number;
  pair: {
    aAudioHash: string;
    bAudioHash: string;
    analysisVersion: number;
  };
  arcPosition: number;
  candidates: JoinRecipe[];
  rejected: RejectedCandidateNote[];
} {
  return {
    kind: "linerave.pair-candidates",
    version: 1,
    pair: {
      aAudioHash: doc.aHash as string,
      bAudioHash: doc.bHash as string,
      analysisVersion: ANALYSIS_VERSION,
    },
    arcPosition:
      typeof doc.arcPosition === "number" && Number.isFinite(doc.arcPosition)
        ? doc.arcPosition
        : 0,
    candidates: doc.candidates,
    rejected: Array.isArray(doc.rejected) ? doc.rejected : [],
  };
}

/**
 * The send-side mirror of fetchTrackRead's validation: a read is
 * uploadable only if the fetch side would accept it back —
 * non-empty hash, this analysis version, a real depth.
 */
function isUploadableRead(read: unknown): read is TrackRead {
  if (!isRecord(read)) return false;
  if (typeof read.audioHash !== "string" || !read.audioHash) return false;
  if (read.analysisVersion !== ANALYSIS_VERSION) return false;
  if (read.depth !== "fast" && read.depth !== "deep") return false;
  return true;
}

export interface ServerClientOptions {
  /**
   * Bearer token for the supply server (its SUPPLY_TOKEN secret).
   * Sent as an Authorization header only when provided; a client
   * without one is refused by the server and reads that as a miss.
   */
  token?: string;
}

/**
 * Speaks the server-mixing envelopes:
 *   GET  {base}/v1/tracks/:audioHash  → linerave.track-read v1
 *   POST {base}/v1/pairs {a, b, arcPosition} → linerave.pair-candidates v1
 *   PUT  {base}/v1/tracks/:audioHash  ← linerave.track-read v1
 *   PUT  {base}/v1/pairs/:aHash/:bHash ← linerave.pair-candidates v1
 * Anything that does not validate — wrong kind, wrong version,
 * fingerprints that disagree with the request, malformed payloads,
 * any network failure — is a miss (null) on the fetch side and a
 * "failed" ContributionStatus on the upload side, never a throw.
 * Uploads are validated before they are sent with the same rules
 * the fetch side validates what it receives, so a document this
 * client would refuse to read back is never offered to the shelf.
 */
export function createServerClient(
  baseUrl: string,
  fetchImpl: FetchImpl = fetch,
  options: ServerClientOptions = {},
): ServerClient {
  const base = typeof baseUrl === "string" ? baseUrl.replace(/\/+$/, "") : "";
  const authHeaders: Record<string, string> =
    typeof options.token === "string" && options.token
      ? { authorization: `Bearer ${options.token}` }
      : {};

  async function fetchTrackRead(audioHash: string): Promise<TrackRead | null> {
    if (!base || !audioHash) return null;
    const body = await fetchJson(
      fetchImpl,
      `${base}/v1/tracks/${encodeURIComponent(audioHash)}`,
      { method: "GET", headers: { ...authHeaders } },
    );
    if (!isRecord(body)) return null;
    if (body.kind !== "linerave.track-read") return null;
    if (body.version !== 1) return null;
    if (body.audioHash !== audioHash) return null;
    if (body.analysisVersion !== ANALYSIS_VERSION) return null;
    const read = body.read;
    if (!isRecord(read)) return null;
    if (read.audioHash !== audioHash) return null;
    if (read.analysisVersion !== ANALYSIS_VERSION) return null;
    if (
      typeof body.depth === "string" &&
      typeof read.depth === "string" &&
      body.depth !== read.depth
    ) {
      return null;
    }
    return read as unknown as TrackRead;
  }

  async function fetchPairCandidates(
    aHash: string,
    bHash: string,
    arcPosition: number,
  ): Promise<{
    candidates: JoinRecipe[];
    rejected: RejectedCandidateNote[];
    arcPosition: number;
  } | null> {
    if (!base || !aHash || !bHash) return null;
    const body = await fetchJson(fetchImpl, `${base}/v1/pairs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders },
      body: JSON.stringify({ a: aHash, b: bHash, arcPosition }),
    });
    if (!isRecord(body)) return null;
    if (body.kind !== "linerave.pair-candidates") return null;
    if (body.version !== 1) return null;
    const pair = body.pair;
    if (!isRecord(pair)) return null;
    if (pair.aAudioHash !== aHash || pair.bAudioHash !== bHash) return null;
    if (pair.analysisVersion !== ANALYSIS_VERSION) return null;
    if (!Array.isArray(body.candidates)) return null;
    const rejected = Array.isArray(body.rejected)
      ? (body.rejected as RejectedCandidateNote[])
      : [];
    const authoredAt =
      typeof body.arcPosition === "number" && Number.isFinite(body.arcPosition)
        ? body.arcPosition
        : arcPosition;
    return {
      candidates: body.candidates as JoinRecipe[],
      rejected,
      arcPosition: authoredAt,
    };
  }

  async function uploadTrackRead(read: TrackRead): Promise<ContributionStatus> {
    if (!base) return "failed";
    if (!isUploadableRead(read)) return "failed";
    const result = await sendForStatus(
      fetchImpl,
      `${base}/v1/tracks/${encodeURIComponent(read.audioHash)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(buildTrackReadEnvelope(read)),
      },
    );
    return contributionStatusOf(result);
  }

  async function uploadPairCandidates(
    doc: PairDocument,
  ): Promise<ContributionStatus> {
    if (!base) return "failed";
    if (!isRecord(doc)) return "failed";
    const { aHash, bHash } = doc;
    if (typeof aHash !== "string" || !aHash) return "failed";
    if (typeof bHash !== "string" || !bHash) return "failed";
    if (!Array.isArray(doc.candidates)) return "failed";
    const result = await sendForStatus(
      fetchImpl,
      `${base}/v1/pairs/${encodeURIComponent(aHash)}/${encodeURIComponent(bHash)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...authHeaders },
        body: JSON.stringify(buildPairCandidatesEnvelope(doc)),
      },
    );
    return contributionStatusOf(result);
  }

  return {
    fetchTrackRead,
    fetchPairCandidates,
    uploadTrackRead,
    uploadPairCandidates,
  };
}

// ---------------------------------------------------------------------
// createSupply
// ---------------------------------------------------------------------

const defaultStorage: SupplyStorage = {
  getRead,
  putRead,
  getPairSet,
  putPairSet,
};

let cachedDefaultAuthor: AuthorCandidatesFn | null = null;

async function defaultAuthor(
  factsA: TrackFacts,
  factsB: TrackFacts,
  ctx: { arcPosition: number; shaping: Shaping },
): Promise<{ candidates: JoinRecipe[]; rejected: RejectedCandidateNote[] }> {
  if (!cachedDefaultAuthor) {
    const module = await import("./authors");
    cachedDefaultAuthor = module.authorCandidates as AuthorCandidatesFn;
  }
  return cachedDefaultAuthor(factsA, factsB, ctx);
}

export function createSupply(deps: SupplyDeps = {}): Supply {
  const storage = deps.storage ?? defaultStorage;
  const runner = deps.runner ?? analysisRunner;
  const author: AuthorCandidatesFn | null = deps.author ?? null;
  const server = deps.server ?? null;
  const isServerEnabled = deps.isServerEnabled ?? (() => false);
  const onContribution = deps.onContribution ?? null;

  function serverUsable(): ServerClient | null {
    if (!server) return null;
    let enabled = false;
    try {
      enabled = isServerEnabled();
    } catch {
      enabled = false;
    }
    return enabled ? server : null;
  }

  function reportContribution(outcome: ContributionOutcome): void {
    if (!onContribution) return;
    try {
      onContribution(outcome);
    } catch {
      // A broken outcome sink must not break the night.
    }
  }

  /**
   * Offer a locally computed read to the shelf. Fire-and-forget
   * by construction: the caller has already decided its result,
   * so this never awaits, never retries, and never throws — the
   * upload settles when it settles and its outcome is reported
   * through onContribution. The kill switch is read again here,
   * at the moment of contribution.
   */
  function contributeRead(read: TrackRead): void {
    const active = serverUsable();
    if (!active) return;
    void (async () => {
      let status: ContributionStatus;
      try {
        status = await active.uploadTrackRead(read);
      } catch {
        status = "failed";
      }
      reportContribution({
        kind: "read",
        status,
        audioHash: read.audioHash,
        address: readStoreKey(read.audioHash, read.depth),
      });
    })();
  }

  /** The pair-document counterpart of contributeRead. */
  function contributePair(doc: PairDocument): void {
    const { aHash, bHash } = doc;
    if (aHash === null || bHash === null) return;
    const active = serverUsable();
    if (!active) return;
    void (async () => {
      let status: ContributionStatus;
      try {
        status = await active.uploadPairCandidates(doc);
      } catch {
        status = "failed";
      }
      reportContribution({
        kind: "pair",
        status,
        aHash,
        bHash,
        address: pairStoreKey(aHash, bHash),
      });
    })();
  }

  async function writeRead(read: TrackRead): Promise<void> {
    try {
      await storage.putRead(read);
    } catch {
      // A failed write-through must not lose a good read.
    }
  }

  async function writePair(
    aHash: string,
    bHash: string,
    doc: PairDocument,
  ): Promise<void> {
    try {
      await storage.putPairSet(aHash, bHash, doc);
    } catch {
      // Same discipline as reads: caching is best-effort.
    }
  }

  async function supplyRead(request: {
    samples: Float32Array;
    sampleRate: number;
    depth: AnalysisDepth;
  }): Promise<SupplyReadResult | null> {
    const { samples, sampleRate, depth } = request;
    let audioHash: string;
    try {
      audioHash = audioFingerprint(samples, sampleRate);
    } catch {
      return null;
    }
    if (!audioHash) return null;

    // 1. Local storage.
    try {
      const cached = await storage.getRead(audioHash, depth);
      if (cached) return { read: cached, source: "cache" };
    } catch {
      // Degrade to the next source.
    }

    // 2. Server (kill-switch gated), written through before use.
    const activeServer = serverUsable();
    if (activeServer) {
      try {
        const served = await activeServer.fetchTrackRead(audioHash);
        // Identity includes depth (§8.1): a read at another depth
        // is not this request's read.
        if (served && served.depth === depth) {
          await writeRead(served);
          return { read: served, source: "server" };
        }
      } catch {
        // Degrade to local analysis.
      }
    }

    // 3. Local analysis via the runner — the offline fallback.
    // A read computed here is new to the world: stored locally,
    // then contributed to the shelf in the background (switch
    // permitting) without delaying this result.
    try {
      const read = await runner.analyse({
        key: audioHash,
        samples,
        sampleRate,
        depth,
      });
      if (read) {
        await writeRead(read);
        contributeRead(read);
        return { read, source: "local" };
      }
    } catch {
      // Total failure.
    }
    return null;
  }

  async function supplyPair(
    factsA: TrackFacts,
    factsB: TrackFacts,
    options: { arcPosition: number },
  ): Promise<SupplyPairResult | null> {
    const arcPosition = options?.arcPosition ?? 0;
    const aHash = factsA?.audioHash ?? null;
    const bHash = factsB?.audioHash ?? null;
    const cacheable = aHash !== null && bHash !== null;

    if (cacheable) {
      // 1. Local pairSets store.
      try {
        const stored = await storage.getPairSet<PairDocument>(aHash, bHash);
        const doc = stored?.pairSet;
        if (
          doc &&
          Array.isArray(doc.candidates) &&
          Array.isArray(doc.rejected)
        ) {
          return {
            candidates: doc.candidates,
            rejected: doc.rejected,
            source: "cache",
            // The document's recorded arcPosition, as authored.
            arcPosition:
              typeof doc.arcPosition === "number" &&
              Number.isFinite(doc.arcPosition)
                ? doc.arcPosition
                : arcPosition,
          };
        }
      } catch {
        // Degrade to the next source.
      }

      // 2. Server (kill-switch gated), stored locally on a hit.
      const activeServer = serverUsable();
      if (activeServer) {
        try {
          const served = await activeServer.fetchPairCandidates(
            aHash,
            bHash,
            arcPosition,
          );
          if (served) {
            const doc: PairDocument = {
              aHash,
              bHash,
              arcPosition: served.arcPosition,
              candidates: served.candidates,
              rejected: served.rejected,
            };
            await writePair(aHash, bHash, doc);
            return {
              candidates: doc.candidates,
              rejected: doc.rejected,
              source: "server",
              arcPosition: doc.arcPosition,
            };
          }
        } catch {
          // Degrade to local authoring.
        }
      }
    }

    // 3. Local author, under NEUTRAL shaping (§8.1 identity
    // authoring), stored locally when the pair is keyable.
    try {
      const authored = author
        ? await author(factsA, factsB, {
            arcPosition,
            shaping: NEUTRAL_SHAPING,
          })
        : await defaultAuthor(factsA, factsB, {
            arcPosition,
            shaping: NEUTRAL_SHAPING,
          });
      if (!authored || !Array.isArray(authored.candidates)) return null;
      const doc: PairDocument = {
        aHash,
        bHash,
        arcPosition,
        candidates: authored.candidates,
        rejected: Array.isArray(authored.rejected) ? authored.rejected : [],
      };
      if (cacheable) {
        await writePair(aHash, bHash, doc);
        // As with reads: a locally authored document is new to
        // the world, so it is contributed in the background.
        contributePair(doc);
      }
      return {
        candidates: doc.candidates,
        rejected: doc.rejected,
        source: "local",
        arcPosition,
      };
    } catch {
      return null;
    }
  }

  return { supplyRead, supplyPair };
}
