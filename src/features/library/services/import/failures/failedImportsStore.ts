import type { ClientImportedTrack } from "../importTypes";
import type { ImportReviewReason, ImportSource } from "@/shared/contracts";

// The failed-imports collection: the holding playlist for songs
// that could not come across. An import must never be all-or-
// nothing, and a song that fails must never simply vanish into a
// "skipped" count — every failure lands here automatically, with
// the song's details, where it came from, and why it failed, kept
// until the user clears it or a later retry succeeds. Entries are
// the source songs (title, artists, album, source id): a failed
// song has no playable track yet, which is exactly why it failed,
// so this collection is a record to act on, not a playable list.

export type FailedImportStage = "matching" | "saving" | "review";

export interface FailedImportEntry {
  /** Stable identity: the same song failing twice updates one entry. */
  key: string;
  source: ImportSource;
  sourceTrack: ClientImportedTrack;
  /** Machine reason (an ImportReviewReason, or "save_failed"). */
  reason: string;
  stage: FailedImportStage;
  /** Title of the playlist the song was being imported into. */
  importTitle: string;
  failedAt: string;
  attempts: number;
}

const STORAGE_KEY = "liner_failed_imports_v1";
const MAX_ENTRIES = 500;

const REASON_WORDS: Record<string, string> = {
  no_catalog_candidates: "No matching song was found",
  catalog_lookup_failed: "The catalogue lookup failed",
  low_confidence_match: "Only an uncertain match was found",
  ambiguous_match: "Several songs could be the right match",
  duration_mismatch: "The closest match was the wrong length",
  save_failed: "The song matched but could not be saved",
  review_denied: "You turned down the proposed match",
};

/** Plain words for a failure reason, for showing to the user. */
export function failedImportReasonWords(reason: string): string {
  return REASON_WORDS[reason] ?? "The song could not be imported";
}

export function failedImportKey(
  source: ImportSource,
  track: ClientImportedTrack,
): string {
  if (track.sourceId) return `${source}:${track.sourceId}`;
  const artist = track.artists[0] ?? "";
  return `${source}:${track.title.trim().toLowerCase()}|${artist.trim().toLowerCase()}`;
}

export interface FailedImportStorage {
  read(): string | null;
  write(value: string): void;
}

function localStorageBackend(): FailedImportStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return {
      read: () => localStorage.getItem(STORAGE_KEY),
      write: (value) => localStorage.setItem(STORAGE_KEY, value),
    };
  } catch {
    return null;
  }
}

export class FailedImportsStore {
  private entries: FailedImportEntry[] = [];
  private readonly storage: FailedImportStorage | null;

  constructor(storage?: FailedImportStorage | null) {
    this.storage = storage === undefined ? localStorageBackend() : storage;
    this.load();
  }

  private load(): void {
    try {
      const raw = this.storage?.read();
      if (!raw) return;
      const parsed = JSON.parse(raw) as FailedImportEntry[];
      if (Array.isArray(parsed)) this.entries = parsed;
    } catch {
      this.entries = [];
    }
  }

  private persist(): void {
    try {
      this.storage?.write(JSON.stringify(this.entries));
    } catch {
      // In-memory only (private mode, tests): the list still works.
    }
  }

  /** Adds failures, updating any entry for a song already held. */
  record(
    additions: Omit<FailedImportEntry, "key" | "attempts">[],
  ): FailedImportEntry[] {
    for (const addition of additions) {
      const key = failedImportKey(addition.source, addition.sourceTrack);
      const existing = this.entries.find((entry) => entry.key === key);
      if (existing) {
        existing.reason = addition.reason;
        existing.stage = addition.stage;
        existing.importTitle = addition.importTitle;
        existing.failedAt = addition.failedAt;
        existing.attempts += 1;
      } else {
        this.entries.push({ ...addition, key, attempts: 1 });
      }
    }
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_ENTRIES);
    }
    this.persist();
    return this.list();
  }

  list(): FailedImportEntry[] {
    return [...this.entries];
  }

  /** Removes entries (e.g. after a retry succeeds). */
  remove(keys: string[]): void {
    const drop = new Set(keys);
    this.entries = this.entries.filter((entry) => !drop.has(entry.key));
    this.persist();
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }
}

/** The shared collection the import flow records into. */
export const failedImports = new FailedImportsStore();

export function recordFailedImports(
  additions: Omit<FailedImportEntry, "key" | "attempts">[],
): FailedImportEntry[] {
  return failedImports.record(additions);
}

export function listFailedImports(): FailedImportEntry[] {
  return failedImports.list();
}
