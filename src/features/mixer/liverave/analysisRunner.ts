// analysisRunner.ts — promise API over the analysis worker.
//
// Queue discipline (designed from the latency requirement, §3.0):
// - ONE request in flight at a time. Analysis is CPU-bound; two at
//   once would only make both slower.
// - Queued FAST requests run before queued DEEP requests: a fast
//   read is wanted for an imminent pair, a deep read is background
//   enrichment.
// - A newly queued FAST request OVERTAKES queued deep work: every
//   queued (not in-flight) DEEP request for a DIFFERENT key is
//   superseded — dropped from the queue and resolved with null
//   (no read produced) — because the caller's attention has moved
//   to the fast key. A queued deep for the SAME key survives: it is
//   the same track's enrichment, and it runs after the fast read.
// - An in-flight request is never preempted: a half-finished
//   analysis is worth less than the seconds it would save.
// Fallback: if Worker construction fails (tests, exotic hosts),
// the runner executes analyseSamples inline (still one at a time,
// via the same queue) for every request from then on. A worker
// that errors mid-request also degrades that request to inline
// rather than losing it.
//
// Hang guard (fix2-0119): a worker can also die SILENTLY — no
// reply, no error event (a crashed worker process, a wedged
// message port). Before this guard, that left the request's
// promise pending forever, and the session's preparation hung
// on it: prepInFlight never drained, the preparing phase could
// neither take over nor give up. Every worker request now runs
// under a watchdog: unanswered past the timeout, the worker is
// declared dead (the onerror discipline — terminate it, never
// build another) and the request is settled inline. analyse()
// therefore always settles.

import AnalysisWorkerCtor from "./analysisWorker?worker&inline";
import { analyseSamples } from "./analyse";
import type {
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
} from "./analysisWorker";
import type { AnalysisDepth, TrackRead } from "./facts";

export interface AnalysisRequest {
  /** Caller-chosen identity for the audio (its fingerprint). */
  key: string;
  samples: Float32Array;
  sampleRate: number;
  depth: AnalysisDepth;
}

/** The slice of the Worker interface the runner relies on. */
export interface AnalysisWorkerLike {
  postMessage: (message: AnalysisWorkerRequest) => void;
  terminate: () => void;
  onmessage: ((event: MessageEvent<AnalysisWorkerResponse>) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
}

/**
 * The hang guard's budget (fix2-0119): how long a worker request
 * may go unanswered before the worker is declared silently dead.
 * Deliberately generous — this is a hang guard, not a performance
 * budget: a healthy analysis of a long track on a slow device
 * takes seconds, not tens of seconds, and a false firing costs an
 * inline re-analysis, never a wrong answer.
 */
export const ANALYSIS_TIMEOUT_MS = 30_000;

export interface AnalysisRunnerOptions {
  /** Injectable for tests; defaults to the real Vite worker. */
  createWorker?: () => AnalysisWorkerLike;
  /** Watchdog budget per worker request; <= 0 disables the guard. */
  timeoutMs?: number;
}

export interface AnalysisRunner {
  analyse(request: AnalysisRequest): Promise<TrackRead | null>;
  dispose(): void;
}

interface Pending {
  request: AnalysisRequest;
  resolve: (read: TrackRead | null) => void;
}

export function createAnalysisRunner(
  options: AnalysisRunnerOptions = {},
): AnalysisRunner {
  const createWorker =
    options.createWorker ??
    (() => new AnalysisWorkerCtor() as unknown as AnalysisWorkerLike);
  const timeoutMs = options.timeoutMs ?? ANALYSIS_TIMEOUT_MS;

  let worker: AnalysisWorkerLike | null = null;
  let workerFailed = false;
  let disposed = false;
  let nextId = 1;
  let inFlight: { pending: Pending; id: number } | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  const fastQueue: Pending[] = [];
  const deepQueue: Pending[] = [];

  function clearWatchdog(): void {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  }

  /**
   * The worker is untrusted from here on (it errored, or it went
   * silent past the watchdog): terminate it, never build another,
   * and finish the in-flight request inline rather than losing
   * it — or leaving it pending forever.
   */
  function degradeInFlightToInline(): void {
    clearWatchdog();
    workerFailed = true;
    try {
      worker?.terminate();
    } catch {
      // Already dead.
    }
    worker = null;
    const current = inFlight;
    inFlight = null;
    if (current) runInline(current.pending);
  }

  function armWatchdog(pending: Pending): void {
    clearWatchdog();
    if (!(timeoutMs > 0)) return;
    watchdog = setTimeout(() => {
      watchdog = null;
      if (disposed) return;
      // Only the request this watchdog was armed for may degrade;
      // a late firing for an already-settled request is nothing.
      if (!inFlight || inFlight.pending !== pending) return;
      degradeInFlightToInline();
    }, timeoutMs);
  }

  function ensureWorker(): AnalysisWorkerLike | null {
    if (workerFailed) return null;
    if (worker) return worker;
    try {
      worker = createWorker();
    } catch {
      workerFailed = true;
      return null;
    }
    worker.onmessage = (event: MessageEvent<AnalysisWorkerResponse>) => {
      const current = inFlight;
      if (!current || event.data.id !== current.id) return;
      clearWatchdog();
      inFlight = null;
      if (event.data.ok) {
        current.pending.resolve(event.data.read);
        pump();
      } else {
        runInline(current.pending);
      }
    };
    worker.onerror = () => {
      degradeInFlightToInline();
    };
    return worker;
  }

  function runInline(pending: Pending): void {
    // In-flight bookkeeping is held by the caller (the queue pump
    // or the worker-error path) until this settles.
    inFlight = { pending, id: 0 };
    setTimeout(() => {
      if (disposed) return;
      let read: TrackRead | null = null;
      try {
        read = analyseSamples(
          pending.request.samples,
          pending.request.sampleRate,
          {
            depth: pending.request.depth,
          },
        );
      } catch {
        read = null;
      }
      if (inFlight?.pending === pending) inFlight = null;
      pending.resolve(read);
      pump();
    }, 0);
  }

  function pump(): void {
    if (disposed || inFlight) return;
    const next = fastQueue.shift() ?? deepQueue.shift();
    if (!next) return;
    const active = ensureWorker();
    if (!active) {
      runInline(next);
      return;
    }
    const id = nextId;
    nextId += 1;
    inFlight = { pending: next, id };
    try {
      active.postMessage({
        id,
        samples: next.request.samples,
        sampleRate: next.request.sampleRate,
        depth: next.request.depth,
      });
      armWatchdog(next);
    } catch {
      inFlight = null;
      runInline(next);
    }
  }

  function analyse(request: AnalysisRequest): Promise<TrackRead | null> {
    if (disposed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const pending: Pending = { request, resolve };
      if (request.depth === "fast") {
        // Overtaking: queued deep work for other keys is dropped.
        for (let i = deepQueue.length - 1; i >= 0; i -= 1) {
          if (deepQueue[i].request.key !== request.key) {
            const [dropped] = deepQueue.splice(i, 1);
            dropped.resolve(null);
          }
        }
        fastQueue.push(pending);
      } else {
        deepQueue.push(pending);
      }
      pump();
    });
  }

  function dispose(): void {
    disposed = true;
    clearWatchdog();
    for (const pending of [...fastQueue, ...deepQueue]) {
      pending.resolve(null);
    }
    fastQueue.length = 0;
    deepQueue.length = 0;
    if (inFlight) {
      inFlight.pending.resolve(null);
      inFlight = null;
    }
    try {
      worker?.terminate();
    } catch {
      // Already dead.
    }
    worker = null;
  }

  return { analyse, dispose };
}

/** Shared runner for the app; the worker is built lazily. */
export const analysisRunner = createAnalysisRunner();
