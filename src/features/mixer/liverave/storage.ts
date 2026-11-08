// storage.ts — the new engine's own persistence (Wave 1.5).
//
// A FRESH IndexedDB database ("liverave-engine-v1") owned by this
// engine alone — the old DJ records in the app's shared database
// are orphaned data, not something this module reads. Four
// stores:
//   reads     — TrackReads, key = audioHash + "@" + version + "@" + depth
//   pairSets  — authored pair documents,
//               key = aHash + ">" + bHash + "@" + version
//   behaviour — the performance behaviour log (auto-increment
//               keys, appended in order, capped at 400 records
//               with the oldest dropped — design §3.6)
//   trackHashes — the attribution bridge: trackId → audioHash,
//               key = trackId. Written by the source path at the
//               one moment a player track and its decoded audio
//               meet (source.ts), so enumeration consumers (the
//               For You feed) can attribute content-addressed
//               reads back to universe tracks WITHOUT putting a
//               track id into a read or the reads store — the
//               content addressing there stays pure. The bridge
//               carries no analysis version: a hash is identity,
//               not a measurement, and the reads it points at are
//               still served only through their own version gates,
//               so a stale attribution simply yields no facts.
//
// Write gates (content-addressed discipline, §3.0): a record is
// SERVED only when the envelope's fingerprint(s) and its
// analysisVersion match the key it was asked under AND the current
// ANALYSIS_VERSION. Anything stale — an older analyser's read, a
// record whose payload disagrees with its key — reads back as
// null, never as data.
//
// Environment note: this is the ONE liverave module allowed to
// touch IndexedDB; it is not part of the §8.4 pure compute core.
// The IndexedDB access sits behind a small backend interface so
// tests (and any non-browser host) can run the exact same gate
// logic against an in-memory backend; no test-only code paths
// exist in the gates themselves.

import { ANALYSIS_VERSION } from "./analyse";
import type { ShelfState } from "./cooldown";
import type { TransitionOutcome } from "./ear";
import type { AnalysisDepth, TrackRead } from "./facts";
import type { BehaviourRecord, BehaviourReason } from "./memory";

export type { BehaviourRecord, BehaviourReason };

export const LIVERAVE_DB_NAME = "liverave-engine-v1";
/**
 * v2 adds the trackHashes attribution-bridge store.
 * v3 adds the wave's outcomes store (the Ear's persisted
 * transition history) and shelf store (Cooldown Shelf state).
 */
export const LIVERAVE_DB_VERSION = 3;
export const BEHAVIOUR_CAP = 400;

export type EngineStoreName =
  "reads" | "pairSets" | "behaviour" | "trackHashes" | "outcomes" | "shelf";
type StorageKey = string | number;

// ---------------------------------------------------------------------
// Record shapes
// ---------------------------------------------------------------------

export interface StoredPairSet<T = unknown> {
  aHash: string;
  bHash: string;
  analysisVersion: number;
  /** The authored pair document, opaque to storage. */
  pairSet: T;
  storedAt: number;
}

// The behaviour record's shape is OWNED by memory.ts (design
// §3.6: the log owns the shape; storage persists it). The local
// definition that used to live here ({technique: string | null,
// pair: {aHash, bHash} | null, poolSize: number | null}) diverged
// field-wise from memory's ({technique?: ScratchTechnique,
// pairTrackIds: [string, string], poolSize: number}); Wave 2D
// reconciled storage to memory's shape so the session can wire
// createBehaviourLog({append, list}) over appendBehaviour /
// listBehaviour with a thin async adapter and no field mapping.

interface StoredReadEnvelope {
  key: string;
  audioHash: string;
  analysisVersion: number;
  depth: AnalysisDepth;
  read: TrackRead;
  storedAt: number;
}

interface StoredPairEnvelope<T = unknown> extends StoredPairSet<T> {
  key: string;
}

/** One attribution-bridge entry: this track resolved to this audio. */
export interface StoredTrackHash {
  trackId: string;
  audioHash: string;
  storedAt: number;
}

interface StoredTrackHashEnvelope extends StoredTrackHash {
  key: string;
}

// ---------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------

export function readStoreKey(
  audioHash: string,
  depth: AnalysisDepth,
  version: number = ANALYSIS_VERSION,
): string {
  return `${audioHash}@${version}@${depth}`;
}

export function pairStoreKey(
  aHash: string,
  bHash: string,
  version: number = ANALYSIS_VERSION,
): string {
  return `${aHash}>${bHash}@${version}`;
}

// ---------------------------------------------------------------------
// Backend interface + in-memory implementation
// ---------------------------------------------------------------------

export interface EngineStorageBackend {
  get(store: EngineStoreName, key: StorageKey): Promise<unknown>;
  put(store: EngineStoreName, key: StorageKey, value: unknown): Promise<void>;
  /** Append with an auto-increment key (behaviour log). */
  add(store: EngineStoreName, value: unknown): Promise<StorageKey>;
  delete(store: EngineStoreName, key: StorageKey): Promise<void>;
  clear(store: EngineStoreName): Promise<void>;
  /** All entries, keys ascending (numeric or lexicographic). */
  entries(
    store: EngineStoreName,
  ): Promise<{ key: StorageKey; value: unknown }[]>;
}

/** In-memory backend: tests and non-IndexedDB hosts. */
export class MemoryEngineStorageBackend implements EngineStorageBackend {
  private stores = new Map<EngineStoreName, Map<StorageKey, unknown>>();
  private counters = new Map<EngineStoreName, number>();

  private store(name: EngineStoreName): Map<StorageKey, unknown> {
    let existing = this.stores.get(name);
    if (!existing) {
      existing = new Map();
      this.stores.set(name, existing);
    }
    return existing;
  }

  async get(store: EngineStoreName, key: StorageKey): Promise<unknown> {
    return this.store(store).get(key) ?? null;
  }

  async put(
    store: EngineStoreName,
    key: StorageKey,
    value: unknown,
  ): Promise<void> {
    this.store(store).set(key, value);
  }

  async add(store: EngineStoreName, value: unknown): Promise<StorageKey> {
    const next = (this.counters.get(store) ?? 0) + 1;
    this.counters.set(store, next);
    this.store(store).set(next, value);
    return next;
  }

  async delete(store: EngineStoreName, key: StorageKey): Promise<void> {
    this.store(store).delete(key);
  }

  async clear(store: EngineStoreName): Promise<void> {
    this.store(store).clear();
  }

  async entries(
    store: EngineStoreName,
  ): Promise<{ key: StorageKey; value: unknown }[]> {
    const all = Array.from(this.store(store).entries(), ([key, value]) => ({
      key,
      value,
    }));
    all.sort((a, z) =>
      typeof a.key === "number" && typeof z.key === "number"
        ? a.key - z.key
        : String(a.key).localeCompare(String(z.key)),
    );
    return all;
  }
}

// ---------------------------------------------------------------------
// IndexedDB backend
// ---------------------------------------------------------------------

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

class IndexedDbEngineStorageBackend implements EngineStorageBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(LIVERAVE_DB_NAME, LIVERAVE_DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("reads")) {
            db.createObjectStore("reads");
          }
          if (!db.objectStoreNames.contains("pairSets")) {
            db.createObjectStore("pairSets");
          }
          if (!db.objectStoreNames.contains("behaviour")) {
            db.createObjectStore("behaviour", { autoIncrement: true });
          }
          if (!db.objectStoreNames.contains("trackHashes")) {
            db.createObjectStore("trackHashes");
          }
          if (!db.objectStoreNames.contains("outcomes")) {
            db.createObjectStore("outcomes", { autoIncrement: true });
          }
          if (!db.objectStoreNames.contains("shelf")) {
            db.createObjectStore("shelf");
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.dbPromise;
  }

  private async withStore<T>(
    store: EngineStoreName,
    mode: IDBTransactionMode,
    run: (objectStore: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await this.open();
    const tx = db.transaction(store, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const result = await run(tx.objectStore(store));
    await done;
    return result;
  }

  async get(store: EngineStoreName, key: StorageKey): Promise<unknown> {
    return this.withStore(store, "readonly", async (os) => {
      const value = await requestToPromise(os.get(key as string));
      return value ?? null;
    });
  }

  async put(
    store: EngineStoreName,
    key: StorageKey,
    value: unknown,
  ): Promise<void> {
    await this.withStore(store, "readwrite", async (os) => {
      await requestToPromise(os.put(value, key as string));
    });
  }

  async add(store: EngineStoreName, value: unknown): Promise<StorageKey> {
    return this.withStore(store, "readwrite", async (os) => {
      const key = await requestToPromise(os.add(value));
      return key as StorageKey;
    });
  }

  async delete(store: EngineStoreName, key: StorageKey): Promise<void> {
    await this.withStore(store, "readwrite", async (os) => {
      await requestToPromise(os.delete(key as string));
    });
  }

  async clear(store: EngineStoreName): Promise<void> {
    await this.withStore(store, "readwrite", async (os) => {
      await requestToPromise(os.clear());
    });
  }

  async entries(
    store: EngineStoreName,
  ): Promise<{ key: StorageKey; value: unknown }[]> {
    return this.withStore(store, "readonly", async (os) => {
      const keys = await requestToPromise(os.getAllKeys());
      const values = await requestToPromise(os.getAll());
      const all = keys.map((key, i) => ({
        key: key as StorageKey,
        value: values[i],
      }));
      all.sort((a, z) =>
        typeof a.key === "number" && typeof z.key === "number"
          ? a.key - z.key
          : String(a.key).localeCompare(String(z.key)),
      );
      return all;
    });
  }
}

// ---------------------------------------------------------------------
// Storage API (gate logic — identical over any backend)
// ---------------------------------------------------------------------

export interface LiveRaveEngineStorage {
  putRead(read: TrackRead): Promise<void>;
  getRead(audioHash: string, depth: AnalysisDepth): Promise<TrackRead | null>;
  listReads(): Promise<TrackRead[]>;
  putPairSet<T>(aHash: string, bHash: string, pairSet: T): Promise<void>;
  getPairSet<T>(aHash: string, bHash: string): Promise<StoredPairSet<T> | null>;
  appendBehaviour(record: BehaviourRecord): Promise<void>;
  listBehaviour(): Promise<BehaviourRecord[]>;
  /** Append one labelled transition outcome (Ear, wave item 5). */
  appendOutcome(outcome: TransitionOutcome): Promise<void>;
  /** Every persisted transition outcome, append order. */
  listOutcomes(): Promise<TransitionOutcome[]>;
  /** The persisted Cooldown Shelf state for one mode, if any. */
  getShelfState(mode: string): Promise<ShelfState | null>;
  /** Persist the Cooldown Shelf state under its mode key. */
  putShelfState(state: ShelfState): Promise<void>;
  /** Record (or refresh) the bridge pair trackId → audioHash. */
  recordTrackHash(trackId: string, audioHash: string): Promise<void>;
  /** The hash a track last resolved to, or null when unbridged. */
  getTrackHash(trackId: string): Promise<string | null>;
  /** Every bridge pair that passes the envelope gates, by trackId. */
  listTrackHashes(): Promise<ReadonlyMap<string, string>>;
  clearAll(): Promise<void>;
}

export function createEngineStorage(
  backend?: EngineStorageBackend,
): LiveRaveEngineStorage {
  const resolved =
    backend ??
    (typeof indexedDB !== "undefined"
      ? new IndexedDbEngineStorageBackend()
      : new MemoryEngineStorageBackend());

  async function putRead(read: TrackRead): Promise<void> {
    const key = readStoreKey(read.audioHash, read.depth, read.analysisVersion);
    const envelope: StoredReadEnvelope = {
      key,
      audioHash: read.audioHash,
      analysisVersion: read.analysisVersion,
      depth: read.depth,
      read,
      storedAt: Date.now(),
    };
    await resolved.put("reads", key, envelope);
  }

  async function getRead(
    audioHash: string,
    depth: AnalysisDepth,
  ): Promise<TrackRead | null> {
    const key = readStoreKey(audioHash, depth);
    const raw = (await resolved.get("reads", key)) as StoredReadEnvelope | null;
    if (!raw || typeof raw !== "object") return null;
    // Serve nothing stale: envelope key, envelope fingerprint,
    // envelope version, and the payload's own claims must ALL
    // agree with what was asked and the current ANALYSIS_VERSION.
    if (raw.key !== key) return null;
    if (raw.audioHash !== audioHash) return null;
    if (raw.analysisVersion !== ANALYSIS_VERSION) return null;
    if (raw.depth !== depth) return null;
    const read = raw.read;
    if (!read || typeof read !== "object") return null;
    if (read.audioHash !== audioHash) return null;
    if (read.analysisVersion !== ANALYSIS_VERSION) return null;
    if (read.depth !== depth) return null;
    return read;
  }

  /**
   * Every stored read that passes the SAME gates getRead applies —
   * envelope key, envelope fingerprint, envelope version and the
   * payload's own claims must all agree with each other AND the
   * current ANALYSIS_VERSION. A stale or tampered envelope is
   * skipped, never served. When both depths exist for one hash the
   * deep read wins: it is the fuller measurement, and enumeration
   * consumers (the For You feed's coarse facts) want one read per
   * track, not two disagreeing ones.
   */
  async function listReads(): Promise<TrackRead[]> {
    const all = await resolved.entries("reads");
    const byHash = new Map<string, TrackRead>();
    for (const entry of all) {
      const raw = entry.value as StoredReadEnvelope | null;
      if (!raw || typeof raw !== "object") continue;
      if (raw.analysisVersion !== ANALYSIS_VERSION) continue;
      if (
        raw.key !== readStoreKey(raw.audioHash, raw.depth, raw.analysisVersion)
      ) {
        continue;
      }
      const read = raw.read;
      if (!read || typeof read !== "object") continue;
      if (read.audioHash !== raw.audioHash) continue;
      if (read.analysisVersion !== ANALYSIS_VERSION) continue;
      if (read.depth !== raw.depth) continue;
      const existing = byHash.get(read.audioHash);
      if (!existing || (existing.depth !== "deep" && read.depth === "deep")) {
        byHash.set(read.audioHash, read);
      }
    }
    return [...byHash.values()];
  }

  async function putPairSet<T>(
    aHash: string,
    bHash: string,
    pairSet: T,
  ): Promise<void> {
    const key = pairStoreKey(aHash, bHash);
    const envelope: StoredPairEnvelope<T> = {
      key,
      aHash,
      bHash,
      analysisVersion: ANALYSIS_VERSION,
      pairSet,
      storedAt: Date.now(),
    };
    await resolved.put("pairSets", key, envelope);
  }

  async function getPairSet<T>(
    aHash: string,
    bHash: string,
  ): Promise<StoredPairSet<T> | null> {
    const key = pairStoreKey(aHash, bHash);
    const raw = (await resolved.get(
      "pairSets",
      key,
    )) as StoredPairEnvelope<T> | null;
    if (!raw || typeof raw !== "object") return null;
    if (raw.key !== key) return null;
    // Both fingerprints are returned on the record so the caller
    // re-checks them against the audio it actually holds.
    if (raw.aHash !== aHash || raw.bHash !== bHash) return null;
    if (raw.analysisVersion !== ANALYSIS_VERSION) return null;
    return {
      aHash: raw.aHash,
      bHash: raw.bHash,
      analysisVersion: raw.analysisVersion,
      pairSet: raw.pairSet,
      storedAt: raw.storedAt,
    };
  }

  async function appendBehaviour(record: BehaviourRecord): Promise<void> {
    await resolved.add("behaviour", record);
    const all = await resolved.entries("behaviour");
    const excess = all.length - BEHAVIOUR_CAP;
    for (let i = 0; i < excess; i += 1) {
      await resolved.delete("behaviour", all[i].key);
    }
  }

  async function listBehaviour(): Promise<BehaviourRecord[]> {
    const all = await resolved.entries("behaviour");
    return all
      .map((entry) => entry.value)
      .filter(
        (value): value is BehaviourRecord =>
          typeof value === "object" && value !== null,
      );
  }

  // -- The Ear's history + the Shelf (optimisation wave) ----------
  // Same discipline as the behaviour log: outcomes append with an
  // auto-increment key and prune to the behaviour cap; shelf
  // state is one keyed document per personality mode.

  async function appendOutcome(outcome: TransitionOutcome): Promise<void> {
    await resolved.add("outcomes", outcome);
    const all = await resolved.entries("outcomes");
    const excess = all.length - BEHAVIOUR_CAP;
    for (let i = 0; i < excess; i += 1) {
      await resolved.delete("outcomes", all[i].key);
    }
  }

  async function listOutcomes(): Promise<TransitionOutcome[]> {
    const all = await resolved.entries("outcomes");
    return all
      .map((entry) => entry.value)
      .filter(
        (value): value is TransitionOutcome =>
          typeof value === "object" && value !== null,
      );
  }

  async function getShelfState(mode: string): Promise<ShelfState | null> {
    const raw = await resolved.get("shelf", mode);
    if (!raw || typeof raw !== "object") return null;
    const state = raw as ShelfState;
    if (state.mode !== mode) return null;
    return state;
  }

  async function putShelfState(state: ShelfState): Promise<void> {
    await resolved.put("shelf", state.mode, state);
  }

  // -- The attribution bridge -------------------------------------
  // Gates mirror the other stores' discipline: an entry is served
  // only when its envelope key, its trackId and a non-empty string
  // hash all agree. Latest write wins — a track that resolves to
  // different audio (a replaced file) is bridged to what it
  // resolves to NOW, which is the only attribution a consumer may
  // honestly use.

  async function recordTrackHash(
    trackId: string,
    audioHash: string,
  ): Promise<void> {
    if (!trackId || !audioHash) return;
    const envelope: StoredTrackHashEnvelope = {
      key: trackId,
      trackId,
      audioHash,
      storedAt: Date.now(),
    };
    await resolved.put("trackHashes", trackId, envelope);
  }

  function bridgeHashOf(raw: unknown, key: string): string | null {
    if (!raw || typeof raw !== "object") return null;
    const envelope = raw as StoredTrackHashEnvelope;
    if (envelope.key !== key) return null;
    if (envelope.trackId !== key) return null;
    if (typeof envelope.audioHash !== "string" || !envelope.audioHash) {
      return null;
    }
    return envelope.audioHash;
  }

  async function getTrackHash(trackId: string): Promise<string | null> {
    if (!trackId) return null;
    const raw = await resolved.get("trackHashes", trackId);
    return bridgeHashOf(raw, trackId);
  }

  async function listTrackHashes(): Promise<ReadonlyMap<string, string>> {
    const all = await resolved.entries("trackHashes");
    const byTrack = new Map<string, string>();
    for (const entry of all) {
      const hash = bridgeHashOf(entry.value, String(entry.key));
      if (hash !== null) byTrack.set(String(entry.key), hash);
    }
    return byTrack;
  }

  async function clearAll(): Promise<void> {
    await resolved.clear("reads");
    await resolved.clear("pairSets");
    await resolved.clear("behaviour");
    await resolved.clear("trackHashes");
    await resolved.clear("outcomes");
    await resolved.clear("shelf");
  }

  return {
    putRead,
    getRead,
    listReads,
    putPairSet,
    getPairSet,
    appendBehaviour,
    listBehaviour,
    appendOutcome,
    listOutcomes,
    getShelfState,
    putShelfState,
    recordTrackHash,
    getTrackHash,
    listTrackHashes,
    clearAll,
  };
}

// Default instance + the plain-function API later waves import.
const defaultStorage = createEngineStorage();

export function putRead(read: TrackRead): Promise<void> {
  return defaultStorage.putRead(read);
}

export function getRead(
  audioHash: string,
  depth: AnalysisDepth,
): Promise<TrackRead | null> {
  return defaultStorage.getRead(audioHash, depth);
}

export function listReads(): Promise<TrackRead[]> {
  return defaultStorage.listReads();
}

export function putPairSet<T>(
  aHash: string,
  bHash: string,
  pairSet: T,
): Promise<void> {
  return defaultStorage.putPairSet(aHash, bHash, pairSet);
}

export function getPairSet<T>(
  aHash: string,
  bHash: string,
): Promise<StoredPairSet<T> | null> {
  return defaultStorage.getPairSet(aHash, bHash);
}

export function appendBehaviour(record: BehaviourRecord): Promise<void> {
  return defaultStorage.appendBehaviour(record);
}

export function listBehaviour(): Promise<BehaviourRecord[]> {
  return defaultStorage.listBehaviour();
}

export function appendOutcome(outcome: TransitionOutcome): Promise<void> {
  return defaultStorage.appendOutcome(outcome);
}

export function listOutcomes(): Promise<TransitionOutcome[]> {
  return defaultStorage.listOutcomes();
}

export function getShelfState(mode: string): Promise<ShelfState | null> {
  return defaultStorage.getShelfState(mode);
}

export function putShelfState(state: ShelfState): Promise<void> {
  return defaultStorage.putShelfState(state);
}

export function recordTrackHash(
  trackId: string,
  audioHash: string,
): Promise<void> {
  return defaultStorage.recordTrackHash(trackId, audioHash);
}

export function getTrackHash(trackId: string): Promise<string | null> {
  return defaultStorage.getTrackHash(trackId);
}

export function listTrackHashes(): Promise<ReadonlyMap<string, string>> {
  return defaultStorage.listTrackHashes();
}

export function clearAll(): Promise<void> {
  return defaultStorage.clearAll();
}
