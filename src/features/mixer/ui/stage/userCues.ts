// User-placed cues for the DJ stage, kept in localStorage.
//
// One record for every track: Record<trackId, UserCue[]> under a
// single key. Every function survives localStorage being unavailable
// (private mode, a throwing stub, a non-browser environment) or
// corrupt (a value some other version wrote badly): reads fall back
// to an empty list, writes swallow their errors, and nothing here
// ever throws into the UI.

export interface UserCue {
  timeSec: number;
  label: string;
}

const STAGE_CUES_STORAGE_KEY = "linerave_stage_cues_v1";

const MAX_USER_CUES = 8;
const DEDUPE_WINDOW_SEC = 0.5;

type CueStore = Record<string, UserCue[]>;

function sanitiseList(value: unknown): UserCue[] {
  if (!Array.isArray(value)) return [];
  const list: UserCue[] = [];
  for (const entry of value) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as UserCue).timeSec === "number" &&
      Number.isFinite((entry as UserCue).timeSec) &&
      typeof (entry as UserCue).label === "string"
    ) {
      list.push({
        timeSec: Math.max(0, (entry as UserCue).timeSec),
        label: (entry as UserCue).label,
      });
    }
  }
  list.sort((a, z) => a.timeSec - z.timeSec);
  return list;
}

function readStore(): CueStore {
  try {
    if (typeof localStorage === "undefined") return {};
    const raw = localStorage.getItem(STAGE_CUES_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return parsed as CueStore;
  } catch {
    return {};
  }
}

function writeStore(store: CueStore): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STAGE_CUES_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable or full: the in-memory result the caller
    // already holds is the best that can be done.
  }
}

export function loadUserCues(trackId: string): UserCue[] {
  try {
    const store = readStore();
    return sanitiseList(store[trackId]);
  } catch {
    return [];
  }
}

export function saveUserCue(trackId: string, cue: UserCue): UserCue[] {
  const current = loadUserCues(trackId);

  // A non-finite time cannot be placed on the track at all: leave
  // the stored list exactly as it was.
  if (
    !cue ||
    typeof cue.timeSec !== "number" ||
    !Number.isFinite(cue.timeSec)
  ) {
    return current;
  }

  const placed: UserCue = {
    timeSec: Math.max(0, cue.timeSec),
    label: typeof cue.label === "string" ? cue.label : "",
  };

  // Dedupe: a cue within the window of an existing one replaces the
  // nearest such cue instead of stacking on top of it.
  let replaceIdx = -1;
  let replaceDiff = Infinity;
  current.forEach((existing, idx) => {
    const diff = Math.abs(existing.timeSec - placed.timeSec);
    if (diff <= DEDUPE_WINDOW_SEC && diff < replaceDiff) {
      replaceDiff = diff;
      replaceIdx = idx;
    }
  });

  let next: UserCue[];
  if (replaceIdx >= 0) {
    next = current.slice();
    next[replaceIdx] = placed;
  } else {
    // Cap: a full list refuses a genuinely new cue — the new one is
    // dropped and the existing list returned unchanged.
    if (current.length >= MAX_USER_CUES) return current;
    next = [...current, placed];
  }
  next.sort((a, z) => a.timeSec - z.timeSec);

  const store = readStore();
  store[trackId] = next;
  writeStore(store);
  return next;
}

export function clearUserCues(trackId: string): void {
  try {
    const store = readStore();
    if (!(trackId in store)) return;
    delete store[trackId];
    writeStore(store);
  } catch {
    // Nothing to do: clearing is best-effort by design.
  }
}
