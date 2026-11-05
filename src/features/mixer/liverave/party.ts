// party.ts — the fresh liveRave party seam (Wave 2D, design §3.8).
//
// Guest requests arrive as DATA. This module owns the request
// book (dedupe by track, votes by distinct guests) and the
// scheduling judgement; the session owns the night itself and
// passes tonight's context in for each evaluation:
//
// - do-not-play and already-played are ABSOLUTE refusals
//   ("not-tonight") — there is no override input anywhere in this
//   module, by design;
// - otherwise the brain's track fit against tonight's arc and
//   neighbours decides: a strong fit is "scheduled", a middling
//   fit stays "waiting" (the arc moves; it may fit later), a fit
//   too weak for tonight is "not-tonight";
// - scheduled requests are inserted into the upcoming order by
//   insertScheduled, which NEVER places two guest tracks
//   back-to-back — a request that cannot be placed without
//   breaking that rule stays "waiting".

import type { Track } from "@/shared/types";

export type GuestRequestStatus = "scheduled" | "waiting" | "not-tonight";

export interface GuestRequest {
  id: string;
  track: Track;
  /** The first guest who asked for this track. */
  guestId: string;
  /** Distinct guests who asked for this track. */
  voters: string[];
  votes: number;
  status: GuestRequestStatus;
  /** Why the request holds its status (narration-grade text). */
  reason: string | null;
  /** Position in the upcoming order once inserted, else null. */
  slot: number | null;
  requestedAt: number;
}

export interface PartyEvaluationContext {
  playedIds: ReadonlySet<string>;
  doNotPlayIds: ReadonlySet<string>;
  /**
   * The brain's track fit for a requested track against tonight's
   * arc + neighbours, in [0, 1]; null when the track cannot be
   * judged yet (no facts) — unjudged requests wait, never refuse.
   */
  fitOf(track: Track): number | null;
}

/** Fit at/above which a request is scheduled (when a slot exists). */
export const PARTY_FIT_SCHEDULE_MIN = 0.5;
/** Fit below which a request is refused for tonight. */
export const PARTY_FIT_REFUSE_BELOW = 0.3;

export interface PartyScheduler {
  submit(track: Track, guestId?: string): GuestRequest;
  evaluate(ctx: PartyEvaluationContext): GuestRequest[];
  /**
   * Returns the upcoming order with every scheduled request's
   * track inserted (no two guest tracks adjacent). Requests that
   * cannot be placed revert to "waiting".
   */
  insertScheduled(upcoming: Track[]): Track[];
  /** Requests still in play: scheduled or waiting. */
  openRequests(): GuestRequest[];
  allRequests(): GuestRequest[];
  guestStatus(trackId: string): GuestRequestStatus | null;
}

function copyOf(request: GuestRequest): GuestRequest {
  return { ...request, voters: [...request.voters] };
}

export function createPartyScheduler(
  deps: { now?: () => number } = {},
): PartyScheduler {
  const now = deps.now ?? (() => Date.now());
  const requests: GuestRequest[] = [];
  let sequence = 0;

  function submit(track: Track, guestId = "guest"): GuestRequest {
    const existing = requests.find((r) => r.track.id === track.id);
    if (existing) {
      if (!existing.voters.includes(guestId)) {
        existing.voters.push(guestId);
        existing.votes = existing.voters.length;
      }
      return copyOf(existing);
    }
    sequence += 1;
    const request: GuestRequest = {
      id: `guest-request-${sequence}`,
      track,
      guestId,
      voters: [guestId],
      votes: 1,
      status: "waiting",
      reason: "waiting for tonight's fit",
      slot: null,
      requestedAt: now(),
    };
    requests.push(request);
    return copyOf(request);
  }

  function evaluate(ctx: PartyEvaluationContext): GuestRequest[] {
    for (const request of requests) {
      const trackId = request.track.id;
      // Absolute refusals first — they override even a request
      // that was scheduled earlier in the night.
      if (ctx.doNotPlayIds.has(trackId)) {
        request.status = "not-tonight";
        request.reason = "on tonight's do-not-play list";
        request.slot = null;
        continue;
      }
      if (ctx.playedIds.has(trackId)) {
        request.status = "not-tonight";
        request.reason = "already played tonight";
        request.slot = null;
        continue;
      }
      if (request.status === "not-tonight") {
        // A fit-based refusal earlier in the night may soften if
        // the arc has moved on; absolute refusals returned above.
        // Re-judge it below like any waiting request.
        request.status = "waiting";
      }
      const fit = ctx.fitOf(request.track);
      if (fit === null) {
        request.status = "waiting";
        request.reason = "not analysed yet — waiting";
        request.slot = null;
        continue;
      }
      if (fit < PARTY_FIT_REFUSE_BELOW) {
        request.status = "not-tonight";
        request.reason = `does not fit tonight's arc (fit ${fit.toFixed(2)})`;
        request.slot = null;
        continue;
      }
      if (fit >= PARTY_FIT_SCHEDULE_MIN) {
        request.status = "scheduled";
        request.reason = `fits tonight's arc (fit ${fit.toFixed(2)})`;
        continue;
      }
      request.status = "waiting";
      request.reason = `close, but not tonight's fit yet (fit ${fit.toFixed(2)})`;
      request.slot = null;
    }
    return requests.map(copyOf);
  }

  function insertScheduled(upcoming: Track[]): Track[] {
    const scheduled = requests
      .filter((r) => r.status === "scheduled")
      .sort((a, z) => z.votes - a.votes || a.requestedAt - z.requestedAt);
    if (scheduled.length === 0) return [...upcoming];
    const guestIds = new Set(scheduled.map((r) => r.track.id));
    // Base order: the upcoming list without the guest tracks
    // themselves (they may already sit in it from an earlier pass).
    const base = upcoming.filter((t) => !guestIds.has(t.id));
    const result: Track[] = [];
    const placed = new Set<string>();
    let guestIndex = 0;
    const placeNextGuest = (): void => {
      const request = scheduled[guestIndex];
      if (!request) return;
      result.push(request.track);
      request.slot = result.length - 1;
      placed.add(request.id);
      guestIndex += 1;
    };
    for (let i = 0; i < base.length; i += 1) {
      result.push(base[i]);
      // A guest may follow a host track; the loop's next host track
      // then separates it from any following guest.
      if (guestIndex < scheduled.length && i < base.length - 1) {
        placeNextGuest();
      }
    }
    // One trailing guest may close the list (its predecessor is a
    // host track or the list was empty host-side but for guests —
    // a lone guest is never "back-to-back").
    if (guestIndex < scheduled.length) {
      const last = result[result.length - 1];
      if (!last || !guestIds.has(last.id)) placeNextGuest();
    }
    // Anything unplaced cannot be scheduled without two guest
    // tracks touching: it honestly waits.
    for (const request of scheduled) {
      if (!placed.has(request.id)) {
        request.status = "waiting";
        request.reason = "no slot tonight without back-to-back guest tracks";
        request.slot = null;
      }
    }
    return result;
  }

  function openRequests(): GuestRequest[] {
    return requests
      .filter((r) => r.status === "scheduled" || r.status === "waiting")
      .map(copyOf);
  }

  function allRequests(): GuestRequest[] {
    return requests.map(copyOf);
  }

  function guestStatus(trackId: string): GuestRequestStatus | null {
    return requests.find((r) => r.track.id === trackId)?.status ?? null;
  }

  return {
    submit,
    evaluate,
    insertScheduled,
    openRequests,
    allRequests,
    guestStatus,
  };
}
