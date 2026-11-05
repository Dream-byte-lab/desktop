import type { Track, TrackArtist } from "@/shared/types";
import type {
  LyricsCandidate,
  LyricsSyncLevel,
} from "@/shared/contracts/lyrics";
import type { LyricsProviderOption } from "@/features/lyrics/store/lyricsStore";
import {
  shouldCacheLyricsCandidate,
  compareLyricsCandidates,
  mergeLyricsProvider,
} from "@/features/lyrics";

export interface CachedTrackRecord {
  id: string;
  title: string;
  artists: string;
  artistId?: string;
  artistList?: TrackArtist[];
  albumTitle?: string;
  albumId?: string;
  coverUrl?: string;
  durationMs: number;
  savedAt: number;
}

export interface CachedAudioRecord {
  trackId: string;
  blob: Blob;
  mimeType: string;
  byteSize: number;
  savedAt: number;
  lastPlayedAt?: number;
}

export type CachedAudioEntry = Pick<
  CachedAudioRecord,
  "trackId" | "byteSize" | "savedAt" | "lastPlayedAt"
>;

export interface CachedLyricsRecord {
  trackId: string;
  syncLevel: LyricsSyncLevel;
  quality: number;
  activeProvider: string;
  availableProviders: LyricsProviderOption[];
  rawLyrics: string;
  rawFormat: string;
  candidate: LyricsCandidate;
  providers?: Record<string, LyricsCandidate>;
  lastCheckedAt: number;
  updatedAt: number;
  userLocked?: boolean;
}

export interface CachedArtistRecord {
  id: string;
  data: any;
  savedAt: number;
  lastCheckedAt: number;
}

/**
 * A persisted track analysis from the retired DJ engine. The
 * `analyses` store and its accessors below are orphaned legacy
 * data: no current code reads or writes them (the live engine
 * owns its own storage in liverave/storage.ts), and existing
 * installs may still hold records in this shape.
 */
export interface CachedAnalysisRecord {
  trackId: string;
  audioHash: string;
  analysisVersion: number;
  /** "fast" | "deep" — the depth the stored analysis was computed at. */
  depth: string;
  analysis: unknown;
  savedAt: number;
}

/**
 * The persisted join history of the retired DJ engine: ONE record
 * holding its whole performed-join log. Like `analyses` above,
 * the `joins` store is orphaned legacy data — no current code
 * reads or writes it; the live engine's behaviour record lives
 * in its own storage (liverave/storage.ts, read by space's
 * joinsReader). The payload stays `unknown` here, as with
 * analyses.
 */
export interface CachedJoinLogRecord {
  id: string;
  joins: unknown;
  savedAt: number;
}

/**
 * The record id the retired engine's join log persisted under in
 * the `joins` store. Kept beside the store itself; no current
 * code reads or writes a record under it.
 */
export const JOINS_LOG_RECORD_ID = "join-log";

/**
 * One on-device play event (interface slice S2, the hybrid listening
 * record): a play as THIS device observed it, written at the same
 * moment the server playback-event report fires. The statistics
 * surface treats this log as authoritative from its first event on;
 * the server history is the record before it. The snapshot is the
 * client Track shape, stored verbatim so rows and aggregates need
 * no conversion. Records are append-only; the log's discipline
 * (count-once merge, counting rule) lives in the space feature,
 * this store's reader/writer.
 */
export interface CachedPlayEventRecord {
  id: string;
  trackId: string;
  track: Track;
  playedDurationMs: number;
  completionRate: number;
  completed: boolean;
  skipped: boolean;
  loopCount: number;
  hasSeekBackward: boolean;
  contextType?: string;
  contextId?: string;
  /** The playback session the play belonged to (server dedupe key). */
  playbackSessionId: string;
  /** When the play ended on this device, epoch milliseconds. */
  listenedAtMs: number;
}

const DB_NAME = "liner_db_v1";
const DB_VERSION = 7;

const MEM_AUDIO_LIMIT = 3;
// the memory maps only sit in front of indexeddb: cap them so a long session doesn't keep every record it saw
const MEM_TRACK_LIMIT = 500;
const MEM_LYRICS_LIMIT = 100;
const MEM_ARTIST_LIMIT = 100;
const MEM_ANALYSIS_LIMIT = 50;
// the play log's memory copy only fronts indexeddb (and is the whole
// store where indexeddb is absent): it keeps the statistics bound's
// worth of most recent events — older ones live only on disk.
const MEM_PLAY_LIMIT = 2000;

// keeps the most recently written entries; maps iterate in insertion order, so the first key is the oldest
function rememberLimited<T>(
  map: Map<string, T>,
  key: string,
  value: T,
  limit: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

class LinerDb {
  private dbPromise: Promise<IDBDatabase> | null = null;
  private isSupported = typeof indexedDB !== "undefined";

  private memTracks = new Map<string, CachedTrackRecord>();
  private memAudio = new Map<string, CachedAudioRecord>();
  private memLyrics = new Map<string, CachedLyricsRecord>();
  private memArtists = new Map<string, CachedArtistRecord>();
  private memAnalyses = new Map<string, CachedAnalysisRecord>();
  private memJoins = new Map<string, CachedJoinLogRecord>();
  private memPlays: CachedPlayEventRecord[] = [];

  private handleDbError() {
    this.dbPromise = null;
  }

  private open(): Promise<IDBDatabase> {
    if (!this.isSupported) {
      return Promise.reject(new Error("IndexedDB is not available"));
    }

    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        this.dbPromise = null;
        reject(err);
        return;
      }

      request.onupgradeneeded = (event) => {
        const db = request.result;

        if (!db.objectStoreNames.contains("tracks")) {
          const trackStore = db.createObjectStore("tracks", { keyPath: "id" });
          trackStore.createIndex("savedAt", "savedAt", { unique: false });
        }

        if (!db.objectStoreNames.contains("audio")) {
          const audioStore = db.createObjectStore("audio", {
            keyPath: "trackId",
          });
          audioStore.createIndex("savedAt", "savedAt", { unique: false });
          audioStore.createIndex("byteSize", "byteSize", { unique: false });
          audioStore.createIndex("lastPlayedAt", "lastPlayedAt", {
            unique: false,
          });
        } else {
          const audioStore = request.transaction?.objectStore("audio");
          if (audioStore && !audioStore.indexNames.contains("lastPlayedAt")) {
            audioStore.createIndex("lastPlayedAt", "lastPlayedAt", {
              unique: false,
            });
          }
        }

        if (!db.objectStoreNames.contains("lyrics")) {
          const lyricsStore = db.createObjectStore("lyrics", {
            keyPath: "trackId",
          });
          lyricsStore.createIndex("lastCheckedAt", "lastCheckedAt", {
            unique: false,
          });
          lyricsStore.createIndex("syncLevel", "syncLevel", { unique: false });
        } else if (event.oldVersion < 4) {
          // clear legacy lyrics store on v4 migration
          try {
            request.transaction?.objectStore("lyrics").clear();
          } catch {}
        }

        if (!db.objectStoreNames.contains("artists")) {
          const artistStore = db.createObjectStore("artists", {
            keyPath: "id",
          });
          artistStore.createIndex("lastCheckedAt", "lastCheckedAt", {
            unique: false,
          });
        }

        if (!db.objectStoreNames.contains("analyses")) {
          const analysisStore = db.createObjectStore("analyses", {
            keyPath: "trackId",
          });
          analysisStore.createIndex("savedAt", "savedAt", { unique: false });
        }

        if (!db.objectStoreNames.contains("joins")) {
          const joinStore = db.createObjectStore("joins", { keyPath: "id" });
          joinStore.createIndex("savedAt", "savedAt", { unique: false });
        }

        if (!db.objectStoreNames.contains("plays")) {
          const playStore = db.createObjectStore("plays", { keyPath: "id" });
          playStore.createIndex("listenedAtMs", "listenedAtMs", {
            unique: false,
          });
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onclose = () => {
          this.dbPromise = null;
        };
        db.onversionchange = () => {
          try {
            db.close();
          } catch {}
          this.dbPromise = null;
        };
        db.onerror = () => {
          this.dbPromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        this.dbPromise = null;
        reject(request.error);
      };

      request.onblocked = () => {
        this.dbPromise = null;
      };
    });

    return this.dbPromise;
  }

  // executes indexeddb transaction with one auto-reconnect retry and zero unhandled rejections
  private async runTransaction<T>(
    storeName:
      | "tracks"
      | "audio"
      | "lyrics"
      | "artists"
      | "analyses"
      | "joins"
      | "plays",
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T | null> {
    if (!this.isSupported) return null;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const db = await this.open();
        return await new Promise<T>((resolve, reject) => {
          try {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(new Error("tx aborted"));
            operation(store).then(resolve, reject);
          } catch (err) {
            reject(err);
          }
        });
      } catch {
        this.handleDbError();
        if (attempt === 0) {
          // retry once on fresh connection
          continue;
        }
      }
    }
    return null;
  }

  async getTrack(id: string): Promise<CachedTrackRecord | null> {
    const mem = this.memTracks.get(id);
    if (mem) return mem;

    const result = await this.runTransaction("tracks", "readonly", (store) => {
      return new Promise<CachedTrackRecord | null>((resolve) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    });

    if (result) {
      rememberLimited(this.memTracks, id, result, MEM_TRACK_LIMIT);
      return result;
    }
    return this.memTracks.get(id) || null;
  }

  async putTrack(track: Track): Promise<void> {
    const record: CachedTrackRecord = {
      id: track.id,
      title: track.title,
      artists: track.artists,
      artistId: track.artistId,
      artistList: track.artistList?.map(({ id, name }) => ({ id, name })),
      albumTitle: track.album?.title,
      albumId: track.album?.id,
      coverUrl: track.coverUrl,
      durationMs: track.durationMs,
      savedAt: Date.now(),
    };
    rememberLimited(this.memTracks, track.id, record, MEM_TRACK_LIMIT);

    await this.runTransaction("tracks", "readwrite", (store) => {
      return new Promise<void>((resolve, reject) => {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  }

  async getTotalTrackBytes(): Promise<number> {
    const result = await this.runTransaction("tracks", "readonly", (store) => {
      return new Promise<number>((resolve) => {
        let total = 0;
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const val = cursor.value as CachedTrackRecord;
            total += JSON.stringify(val || {}).length * 2;
            cursor.continue();
          } else {
            resolve(total);
          }
        };
        req.onerror = () => resolve(0);
      });
    });

    if (result !== null && result !== undefined) {
      return result;
    }

    let total = 0;
    for (const item of this.memTracks.values()) {
      total += JSON.stringify(item || {}).length * 2;
    }
    return total;
  }

  private rememberAudio(trackId: string, record: CachedAudioRecord): void {
    rememberLimited(this.memAudio, trackId, record, MEM_AUDIO_LIMIT);
  }

  async getAudio(trackId: string): Promise<CachedAudioRecord | null> {
    const mem = this.memAudio.get(trackId);
    if (mem) {
      this.rememberAudio(trackId, mem);
      return mem;
    }

    const result = await this.runTransaction("audio", "readonly", (store) => {
      return new Promise<CachedAudioRecord | null>((resolve) => {
        const req = store.get(trackId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    });

    if (result) {
      this.rememberAudio(trackId, result);
      return result;
    }
    return this.memAudio.get(trackId) || null;
  }

  async putAudio(
    trackId: string,
    blob: Blob,
    mimeType: string,
    lastPlayedAt?: number,
  ): Promise<void> {
    const existing = this.memAudio.get(trackId);
    const now = Date.now();
    const record: CachedAudioRecord = {
      trackId,
      blob,
      mimeType,
      byteSize: blob.size,
      savedAt: existing?.savedAt ?? now,
      lastPlayedAt: lastPlayedAt ?? now,
    };
    this.rememberAudio(trackId, record);

    await this.runTransaction("audio", "readwrite", (store) => {
      return new Promise<void>((resolve, reject) => {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  }

  async touchAudio(trackId: string): Promise<void> {
    const record = await this.getAudio(trackId);
    if (!record) return;
    record.lastPlayedAt = Date.now();
    this.rememberAudio(trackId, record);

    await this.runTransaction("audio", "readwrite", (store) => {
      return new Promise<void>((resolve) => {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    });
  }

  async getOldestAudioRecords(): Promise<CachedAudioRecord[]> {
    const result = await this.runTransaction("audio", "readonly", (store) => {
      return new Promise<CachedAudioRecord[]>((resolve) => {
        const records: CachedAudioRecord[] = [];
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            records.push(cursor.value as CachedAudioRecord);
            cursor.continue();
          } else {
            records.sort(
              (a, b) =>
                (a.lastPlayedAt ?? a.savedAt) - (b.lastPlayedAt ?? b.savedAt),
            );
            resolve(records);
          }
        };
        req.onerror = () => resolve([]);
      });
    });

    if (result && result.length > 0) {
      return result;
    }

    const memList = Array.from(this.memAudio.values());
    memList.sort(
      (a, b) => (a.lastPlayedAt ?? a.savedAt) - (b.lastPlayedAt ?? b.savedAt),
    );
    return memList;
  }

  async listAudioEntries(): Promise<CachedAudioEntry[]> {
    const result = await this.runTransaction("audio", "readonly", (store) => {
      return new Promise<CachedAudioEntry[]>((resolve) => {
        const entries: CachedAudioEntry[] = [];
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const record = cursor.value as CachedAudioRecord;
            entries.push({
              trackId: record.trackId,
              byteSize: record.byteSize,
              savedAt: record.savedAt,
              lastPlayedAt: record.lastPlayedAt,
            });
            cursor.continue();
          } else {
            resolve(entries);
          }
        };
        req.onerror = () => resolve([]);
      });
    });

    return result ?? [];
  }

  async hasAudio(trackId: string): Promise<boolean> {
    if (this.memAudio.has(trackId)) return true;

    const result = await this.runTransaction("audio", "readonly", (store) => {
      return new Promise<boolean>((resolve) => {
        const req = store.count(IDBKeyRange.only(trackId));
        req.onsuccess = () => resolve(req.result > 0);
        req.onerror = () => resolve(false);
      });
    });

    return result ?? this.memAudio.has(trackId);
  }

  async deleteAudio(trackId: string): Promise<void> {
    this.memAudio.delete(trackId);

    await this.runTransaction("audio", "readwrite", (store) => {
      return new Promise<void>((resolve) => {
        const req = store.delete(trackId);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    });
  }

  async getTotalAudioBytes(): Promise<number> {
    const result = await this.runTransaction("audio", "readonly", (store) => {
      return new Promise<number>((resolve) => {
        let total = 0;
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const val = cursor.value as CachedAudioRecord;
            total += val.byteSize || val.blob?.size || 0;
            cursor.continue();
          } else {
            resolve(total);
          }
        };
        req.onerror = () => resolve(0);
      });
    });

    if (result !== null && result !== undefined) {
      return result;
    }

    let total = 0;
    for (const item of this.memAudio.values()) {
      total += item.byteSize || 0;
    }
    return total;
  }

  async getLyrics(trackId: string): Promise<CachedLyricsRecord | null> {
    const mem = this.memLyrics.get(trackId);
    if (mem) return mem;

    const result = await this.runTransaction("lyrics", "readonly", (store) => {
      return new Promise<CachedLyricsRecord | null>((resolve) => {
        const req = store.get(trackId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    });

    if (result) {
      if (!result.providers) {
        result.providers = {};
        if (result.candidate) {
          result.providers[result.candidate.provider.toLowerCase().trim()] =
            result.candidate;
        }
        if (result.availableProviders) {
          for (const opt of result.availableProviders) {
            if (opt.candidate) {
              result.providers[opt.provider.toLowerCase().trim()] =
                opt.candidate;
            }
          }
        }
      }
      rememberLimited(this.memLyrics, trackId, result, MEM_LYRICS_LIMIT);
      return result;
    }
    return this.memLyrics.get(trackId) || null;
  }

  async putLyrics(record: CachedLyricsRecord): Promise<void> {
    const providers: Record<string, LyricsCandidate> = {
      ...record.providers,
    };

    if (record.candidate) mergeLyricsProvider(providers, record.candidate);

    if (record.availableProviders) {
      for (const opt of record.availableProviders) {
        if (opt.candidate) mergeLyricsProvider(providers, opt.candidate);
      }
    }

    const validCandidates = Object.values(providers).filter(
      shouldCacheLyricsCandidate,
    );
    if (validCandidates.length === 0) {
      return;
    }

    const validOptions: LyricsProviderOption[] = validCandidates
      .map((c) => ({
        provider: c.provider,
        syncLevel: c.syncLevel,
        quality: c.quality.total,
        candidate: c,
      }))
      .sort((a, b) => compareLyricsCandidates(a.candidate, b.candidate));

    const primaryCandidate =
      record.candidate && shouldCacheLyricsCandidate(record.candidate)
        ? record.candidate
        : validOptions[0].candidate;

    const sanitizedRecord: CachedLyricsRecord = {
      ...record,
      syncLevel: primaryCandidate.syncLevel,
      quality: primaryCandidate.quality.total,
      activeProvider: primaryCandidate.provider,
      rawLyrics: primaryCandidate.lyrics.content,
      rawFormat: primaryCandidate.lyrics.format,
      candidate: primaryCandidate,
      providers,
      availableProviders: validOptions,
    };

    rememberLimited(
      this.memLyrics,
      record.trackId,
      sanitizedRecord,
      MEM_LYRICS_LIMIT,
    );

    await this.runTransaction("lyrics", "readwrite", (store) => {
      return new Promise<void>((resolve, reject) => {
        const req = store.put(sanitizedRecord);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  }

  async updateLyricsChecked(trackId: string): Promise<void> {
    const existing = await this.getLyrics(trackId);
    if (!existing) return;
    existing.lastCheckedAt = Date.now();
    await this.putLyrics(existing);
  }

  async getTotalLyricsBytes(): Promise<number> {
    const result = await this.runTransaction("lyrics", "readonly", (store) => {
      return new Promise<number>((resolve) => {
        let total = 0;
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const val = cursor.value as CachedLyricsRecord;
            let recordBytes = 0;
            if (val.providers) {
              for (const cand of Object.values(val.providers)) {
                recordBytes += (cand.lyrics?.content?.length || 0) * 2;
              }
            } else {
              recordBytes = (val.rawLyrics?.length || 0) * 2;
            }
            total += recordBytes;
            cursor.continue();
          } else {
            resolve(total);
          }
        };
        req.onerror = () => resolve(0);
      });
    });

    if (result !== null && result !== undefined) {
      return result;
    }

    let total = 0;
    for (const item of this.memLyrics.values()) {
      let recordBytes = 0;
      if (item.providers) {
        for (const cand of Object.values(item.providers)) {
          recordBytes += (cand.lyrics?.content?.length || 0) * 2;
        }
      } else {
        recordBytes = (item.rawLyrics?.length || 0) * 2;
      }
      total += recordBytes;
    }
    return total;
  }

  async getArtist(id: string): Promise<CachedArtistRecord | null> {
    const mem = this.memArtists.get(id);
    if (mem) return mem;

    const result = await this.runTransaction("artists", "readonly", (store) => {
      return new Promise<CachedArtistRecord | null>((resolve) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    });

    if (result) {
      rememberLimited(this.memArtists, id, result, MEM_ARTIST_LIMIT);
      return result;
    }
    return this.memArtists.get(id) || null;
  }

  async putArtist(record: CachedArtistRecord): Promise<void> {
    rememberLimited(this.memArtists, record.id, record, MEM_ARTIST_LIMIT);

    await this.runTransaction("artists", "readwrite", (store) => {
      return new Promise<void>((resolve, reject) => {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  }

  async updateArtistChecked(id: string): Promise<void> {
    const existing = await this.getArtist(id);
    if (!existing) return;
    existing.lastCheckedAt = Date.now();
    await this.putArtist(existing);
  }

  async getAnalysis(trackId: string): Promise<CachedAnalysisRecord | null> {
    const mem = this.memAnalyses.get(trackId);
    if (mem) return mem;

    const result = await this.runTransaction(
      "analyses",
      "readonly",
      (store) => {
        return new Promise<CachedAnalysisRecord | null>((resolve) => {
          const req = store.get(trackId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        });
      },
    );

    if (result) {
      rememberLimited(this.memAnalyses, trackId, result, MEM_ANALYSIS_LIMIT);
      return result;
    }
    return this.memAnalyses.get(trackId) || null;
  }

  async putAnalysis(record: CachedAnalysisRecord): Promise<void> {
    rememberLimited(
      this.memAnalyses,
      record.trackId,
      record,
      MEM_ANALYSIS_LIMIT,
    );

    await this.runTransaction("analyses", "readwrite", (store) => {
      return new Promise<void>((resolve, reject) => {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  }

  async deleteAnalysis(trackId: string): Promise<void> {
    this.memAnalyses.delete(trackId);

    await this.runTransaction("analyses", "readwrite", (store) => {
      return new Promise<void>((resolve) => {
        const req = store.delete(trackId);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    });
  }

  async getJoinLog(id: string): Promise<CachedJoinLogRecord | null> {
    const mem = this.memJoins.get(id);
    if (mem) return mem;

    const result = await this.runTransaction("joins", "readonly", (store) => {
      return new Promise<CachedJoinLogRecord | null>((resolve) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    });

    if (result) {
      this.memJoins.set(id, result);
      return result;
    }
    return this.memJoins.get(id) || null;
  }

  async putJoinLog(record: CachedJoinLogRecord): Promise<void> {
    this.memJoins.set(record.id, record);

    await this.runTransaction("joins", "readwrite", (store) => {
      return new Promise<void>((resolve, reject) => {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  }

  private rememberPlay(record: CachedPlayEventRecord): void {
    const existing = this.memPlays.findIndex((p) => p.id === record.id);
    if (existing >= 0) this.memPlays.splice(existing, 1);
    this.memPlays.push(record);
    if (this.memPlays.length > MEM_PLAY_LIMIT) {
      this.memPlays.splice(0, this.memPlays.length - MEM_PLAY_LIMIT);
    }
  }

  async putPlayEvent(record: CachedPlayEventRecord): Promise<void> {
    this.rememberPlay(record);

    await this.runTransaction("plays", "readwrite", (store) => {
      return new Promise<void>((resolve, reject) => {
        const req = store.put(record);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    });
  }

  /**
   * The whole on-device play log, oldest first. Reads walk the
   * listenedAtMs index; where indexeddb is absent the memory copy
   * answers (it is the store there, session-scoped).
   */
  async getPlayEvents(): Promise<CachedPlayEventRecord[]> {
    const result = await this.runTransaction("plays", "readonly", (store) => {
      return new Promise<CachedPlayEventRecord[]>((resolve) => {
        const records: CachedPlayEventRecord[] = [];
        const req = store.index("listenedAtMs").openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            records.push(cursor.value as CachedPlayEventRecord);
            cursor.continue();
          } else {
            resolve(records);
          }
        };
        req.onerror = () => resolve([]);
      });
    });

    if (result !== null && result !== undefined) {
      return result;
    }

    return [...this.memPlays].sort((a, b) => a.listenedAtMs - b.listenedAtMs);
  }

  async getTotalArtistBytes(): Promise<number> {
    const result = await this.runTransaction("artists", "readonly", (store) => {
      return new Promise<number>((resolve) => {
        let total = 0;
        const req = store.openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) {
            const val = cursor.value as CachedArtistRecord;
            total += JSON.stringify(val.data || {}).length * 2;
            cursor.continue();
          } else {
            resolve(total);
          }
        };
        req.onerror = () => resolve(0);
      });
    });

    if (result !== null && result !== undefined) {
      return result;
    }

    let total = 0;
    for (const item of this.memArtists.values()) {
      total += JSON.stringify(item.data || {}).length * 2;
    }
    return total;
  }

  async clearStore(
    storeName:
      | "tracks"
      | "audio"
      | "lyrics"
      | "artists"
      | "analyses"
      | "joins"
      | "plays",
  ): Promise<void> {
    if (storeName === "tracks") this.memTracks.clear();
    if (storeName === "audio") this.memAudio.clear();
    if (storeName === "lyrics") this.memLyrics.clear();
    if (storeName === "artists") this.memArtists.clear();
    if (storeName === "analyses") this.memAnalyses.clear();
    if (storeName === "joins") this.memJoins.clear();
    if (storeName === "plays") this.memPlays = [];

    await this.runTransaction(storeName, "readwrite", (store) => {
      return new Promise<void>((resolve) => {
        const req = store.clear();
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.dbPromise) {
      try {
        const db = await this.dbPromise;
        db.close();
      } catch {}
      this.dbPromise = null;
    }
  }

  async clearAll(): Promise<void> {
    this.memTracks.clear();
    this.memAudio.clear();
    this.memLyrics.clear();
    this.memArtists.clear();
    this.memAnalyses.clear();
    this.memJoins.clear();
    this.memPlays = [];
    await this.clearStore("audio");
    await this.clearStore("tracks");
    await this.clearStore("lyrics");
    await this.clearStore("artists");
    await this.clearStore("analyses");
    await this.clearStore("joins");
    await this.clearStore("plays");
  }
}

export const linerDb = new LinerDb();
