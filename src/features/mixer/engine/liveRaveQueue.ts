import {
  scheduleRequests,
  type RaveContext,
  type RaveDecision,
  type RaveRequest,
  type RaveTrackInfo,
} from "./liveRave";

// liveRave's queue layer: the stateful bridge between guest requests
// and the DJ session's actual upcoming queue.
//
// The scheduler in liveRave.ts is a pure decision-maker. This layer
// owns the party's open requests over time. It combines duplicate
// requests for the same track into one request whose votes are the
// distinct guests asking for it, asks the scheduler to weigh the open
// pool against tonight, inserts the approved tracks into the upcoming
// sequence at the scheduler's slots, keeps the requests that must
// wait open for a later evaluation, and closes the ones refused for
// tonight. A request for a track already lined up by the host is
// recognised as coming soon without inserting a duplicate.
//
// The generic track payload lets the DJ session carry real Liner
// tracks through the layer while tests can use simple stand-ins.

export interface RaveQueueEntry<T> {
  /** The playable track payload the session will queue. */
  track: T;
  /** The analysed facts the scheduler reasons about. */
  info: RaveTrackInfo;
}

export interface RaveQueueSubmission<T> {
  id: string;
  guestId: string;
  entry: RaveQueueEntry<T>;
  requestedAtSec: number;
}

export type RaveQueueContext = Omit<RaveContext, "upcoming">;

export interface RaveQueueEvaluation<T> {
  /** The upcoming sequence after any approved insertions. */
  upcoming: RaveQueueEntry<T>[];
  /** One decision for every request that was open at evaluation time. */
  decisions: RaveDecision[];
  /** True only when at least one requested track was inserted. */
  changed: boolean;
}

interface OpenRaveRequest<T> {
  request: RaveRequest;
  entry: RaveQueueEntry<T>;
  voters: Set<string>;
}

export class LiveRaveQueue<T> {
  private openByTrack = new Map<string, OpenRaveRequest<T>>();

  /**
   * Adds a guest request to the open pool. A second request for a
   * track that is already open is a vote for the original request:
   * the earliest request keeps its identity and waiting time, while
   * its vote count becomes the number of distinct guests behind it.
   * The same guest asking twice does not inflate the count.
   */
  submit(submission: RaveQueueSubmission<T>): RaveRequest {
    const trackId = submission.entry.info.trackId;
    const existing = this.openByTrack.get(trackId);
    if (existing) {
      if (!existing.voters.has(submission.guestId)) {
        existing.voters.add(submission.guestId);
        existing.request = {
          ...existing.request,
          votes: existing.voters.size,
        };
      }
      return existing.request;
    }

    const request: RaveRequest = {
      id: submission.id,
      guestId: submission.guestId,
      track: submission.entry.info,
      requestedAtSec: submission.requestedAtSec,
      votes: 1,
    };
    this.openByTrack.set(trackId, {
      request,
      entry: submission.entry,
      voters: new Set([submission.guestId]),
    });
    return request;
  }

  /** The requests still waiting for a decision or a better moment. */
  get openRequests(): RaveRequest[] {
    return [...this.openByTrack.values()].map((open) => open.request);
  }

  /**
   * Weighs the open pool against the upcoming queue and applies the
   * scheduler's decisions. When `holdReason` is supplied, nothing is
   * scheduled or closed and the queue is returned untouched — the
   * session uses this while a blend is planned or sounding, and
   * while tonight's tracks are still being prepared, because a live
   * join must never be rearranged underneath itself.
   */
  evaluate(
    upcoming: RaveQueueEntry<T>[],
    context: RaveQueueContext,
    holdReason?: string,
  ): RaveQueueEvaluation<T> {
    const openSnapshot = [...this.openByTrack.values()];
    if (openSnapshot.length === 0) {
      return { upcoming, decisions: [], changed: false };
    }

    if (holdReason) {
      return {
        upcoming,
        changed: false,
        decisions: openSnapshot.map((open) => ({
          requestId: open.request.id,
          status: "waiting" as const,
          reason: holdReason,
        })),
      };
    }

    const decisions = new Map<string, RaveDecision>();
    const contenders: OpenRaveRequest<T>[] = [];

    for (const open of openSnapshot) {
      const trackId = open.entry.info.trackId;
      const existingSlot = upcoming.findIndex(
        (entry) => entry.info.trackId === trackId,
      );
      if (existingSlot >= 0) {
        decisions.set(open.request.id, {
          requestId: open.request.id,
          status: "scheduled",
          slotIndex: existingSlot,
          reason: "Already lined up in tonight's queue",
        });
        this.openByTrack.delete(trackId);
      } else {
        contenders.push(open);
      }
    }

    const scheduled = scheduleRequests(
      contenders.map((open) => open.request),
      { ...context, upcoming: upcoming.map((entry) => entry.info) },
    );
    const insertions: { slotIndex: number; entry: RaveQueueEntry<T> }[] = [];

    for (const decision of scheduled) {
      decisions.set(decision.requestId, decision);
      const open = contenders.find(
        (candidate) => candidate.request.id === decision.requestId,
      );
      if (!open) continue;
      if (decision.status === "scheduled") {
        insertions.push({ slotIndex: decision.slotIndex, entry: open.entry });
        this.openByTrack.delete(open.entry.info.trackId);
      } else if (decision.status === "not-tonight") {
        this.openByTrack.delete(open.entry.info.trackId);
      }
    }

    let nextUpcoming = upcoming;
    if (insertions.length > 0) {
      nextUpcoming = [...upcoming];
      // Apply the highest slots first, so every scheduler slot keeps
      // referring to the same place in the original sequence.
      insertions.sort((a, b) => b.slotIndex - a.slotIndex);
      for (const insertion of insertions) {
        nextUpcoming.splice(insertion.slotIndex, 0, insertion.entry);
      }
    }

    return {
      upcoming: nextUpcoming,
      decisions: openSnapshot.map((open) => decisions.get(open.request.id)!),
      changed: insertions.length > 0,
    };
  }

  /** Ends the party pool: every open request is discarded. */
  clear(): void {
    this.openByTrack.clear();
  }
}
