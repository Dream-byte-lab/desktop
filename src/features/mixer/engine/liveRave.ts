import type { KeyEstimate } from "./detectKey";
import { keyCompatibility } from "./keyCompatibility";

// liveRave's request scheduler: the part of the party that used to
// be a human DJ working a request list, done in code. A guest
// request is not an order — it is data. This module weighs every
// open request against tonight as it actually is: the energy the
// arc wants right now, the tracks already lined up, what has
// already played, and the host's do-not-play list. What comes out
// is a decision per request:
//
//   - scheduled:  it fits the night, at the earliest slot where it
//                 also joins musically with its neighbours;
//   - waiting:    it belongs to this night but not to this moment —
//                 a peak weapon asked for during warm-up is HELD for
//                 the peak, not played early and not refused;
//   - not-tonight: the host blocked it, or it already played.
//
// Priority among the requests that fit is votes first, but waiting
// ages a request upward — a patient guest's song eventually outranks
// a fresh pile of votes. Scheduled requests are spaced: no two guest
// tracks ever land back-to-back, so the set keeps its own flow.
//
// v2 (Step 5): this scheduler is one organ of the brain (brain.ts),
// not the brain itself. The session feeds it the night's context —
// its phase energy comes from the brain's arc — and reads tonight's
// track facts from CACHED analyses on the one-track horizon, never
// by preparing the queue tail. The scheduler stays a pure function
// of its inputs, and its thresholds live in one exported tuning
// socket (the scheduler's half of the decision profile's home; the
// values are the shipped judgement, unchanged). Signals never reach
// in here: a do-not-play refusal and an already-played refusal hold
// at any signal pressure, by construction — there is no signal
// input to this function at all.

export interface RaveTrackInfo {
  trackId: string;
  artist: string;
  bpm: number;
  key: KeyEstimate | null;
  /** 0..1 — the track's peak energy, as the analyser measures it. */
  energy: number;
}

export interface RaveRequest {
  id: string;
  guestId: string;
  track: RaveTrackInfo;
  /** Party-clock seconds when the request arrived. */
  requestedAtSec: number;
  /** Duplicate requests for the same song count as votes. */
  votes: number;
}

export interface RaveContext {
  nowSec: number;
  /** 0..1 — the energy the night's arc wants right now. */
  phaseEnergy: number;
  /** Tonight's planned upcoming tracks, next first. */
  upcoming: RaveTrackInfo[];
  /** Host's do-not-play list: track ids or artist names. */
  doNotPlay: string[];
  /** Track ids already played tonight. */
  playedTrackIds: string[];
}

export type RaveDecision =
  | {
      requestId: string;
      status: "scheduled";
      /** Insert position within the upcoming sequence. */
      slotIndex: number;
      reason: string;
    }
  | {
      requestId: string;
      status: "waiting" | "not-tonight";
      reason: string;
    };

/** The scheduler's judgement knobs, in one place. */
export interface LiveRaveTuning {
  /** Energy further than this above the phase is a future-phase track. */
  heldHigh: number;
  /** Energy further than this below the phase is a calmer-moment track. */
  heldLow: number;
  /** Minimum join quality against a neighbour for a slot to be valid. */
  minJoin: number;
  /** Priority gained per minute spent waiting. */
  agePerMin: number;
}

/** The shipped scheduler judgement (v1's constants, socketed). */
export const LIVERAVE_TUNING: LiveRaveTuning = {
  heldHigh: 0.25,
  heldLow: 0.35,
  minJoin: 0.35,
  agePerMin: 0.2,
};

function tempoScore(a: number, b: number): number {
  if (a <= 0 || b <= 0) return 0;
  const ratio = Math.max(a, b) / Math.min(a, b);
  if (ratio <= 1.08) return 1;
  if (ratio >= 1.25) return 0;
  return 1 - (ratio - 1.08) / 0.17;
}

function joinScore(a: RaveTrackInfo, b: RaveTrackInfo): number {
  const key = keyCompatibility(a.key, b.key);
  const keyScore = key ? key.score : 0.5;
  return 0.6 * keyScore + 0.4 * tempoScore(a.bpm, b.bpm);
}

function fitsAt(
  track: RaveTrackInfo,
  upcoming: RaveTrackInfo[],
  slot: number,
  tuning: LiveRaveTuning,
): boolean {
  const left = slot > 0 ? upcoming[slot - 1] : null;
  const right = slot < upcoming.length ? upcoming[slot] : null;
  if (left && joinScore(left, track) < tuning.minJoin) return false;
  if (right && joinScore(track, right) < tuning.minJoin) return false;
  return true;
}

/** Weighs every open request against tonight and decides each one. */
export function scheduleRequests(
  requests: RaveRequest[],
  context: RaveContext,
  tuning: LiveRaveTuning = LIVERAVE_TUNING,
): RaveDecision[] {
  const blocked = new Set(context.doNotPlay);
  const played = new Set(context.playedTrackIds);
  const decisions = new Map<string, RaveDecision>();
  const contenders: RaveRequest[] = [];

  for (const request of requests) {
    const { track } = request;
    if (blocked.has(track.trackId) || blocked.has(track.artist)) {
      decisions.set(request.id, {
        requestId: request.id,
        status: "not-tonight",
        reason: "On the host's do-not-play list",
      });
    } else if (played.has(track.trackId)) {
      decisions.set(request.id, {
        requestId: request.id,
        status: "not-tonight",
        reason: "Already played tonight",
      });
    } else if (track.energy > context.phaseEnergy + tuning.heldHigh) {
      decisions.set(request.id, {
        requestId: request.id,
        status: "waiting",
        reason:
          "Waiting for its moment — it belongs to a bigger part of the night",
      });
    } else if (track.energy < context.phaseEnergy - tuning.heldLow) {
      decisions.set(request.id, {
        requestId: request.id,
        status: "waiting",
        reason: "Waiting for a calmer moment in the night",
      });
    } else {
      contenders.push(request);
    }
  }

  const priority = (request: RaveRequest) =>
    request.votes +
    Math.max(0, (context.nowSec - request.requestedAtSec) / 60) *
      tuning.agePerMin;
  const ordered = [...contenders].sort(
    (a, b) => priority(b) - priority(a) || a.requestedAtSec - b.requestedAtSec,
  );

  const usedSlots: number[] = [];
  for (const request of ordered) {
    let placed: number | null = null;
    for (let slot = 0; slot <= context.upcoming.length; slot += 1) {
      if (usedSlots.some((used) => Math.abs(used - slot) < 2)) continue;
      if (!fitsAt(request.track, context.upcoming, slot, tuning)) continue;
      placed = slot;
      break;
    }
    if (placed !== null) {
      usedSlots.push(placed);
      decisions.set(request.id, {
        requestId: request.id,
        status: "scheduled",
        slotIndex: placed,
        reason: "Coming soon",
      });
    } else {
      decisions.set(request.id, {
        requestId: request.id,
        status: "waiting",
        reason: "No slot where it fits musically yet",
      });
    }
  }

  return requests.map((request) => decisions.get(request.id)!);
}

export type GuestStatus =
  | "received"
  | "waiting for its moment"
  | "coming soon"
  | "played"
  | "not tonight";

/** The honest words a guest sees for a decision. */
export function guestStatus(
  decision: RaveDecision | "played",
  ageSec: number,
): GuestStatus {
  if (decision === "played") return "played";
  if (decision.status === "scheduled") return "coming soon";
  if (decision.status === "not-tonight") return "not tonight";
  return ageSec < 90 ? "received" : "waiting for its moment";
}
