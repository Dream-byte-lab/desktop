import AnalyseWorker from "./analyseTrack.worker?worker&inline";
import {
  analyseTrack,
  mixdownToMono,
  type AnalyseOptions,
  type TrackAnalysis,
} from "./analyseTrack";
import type {
  AnalyseWorkerRequest,
  AnalyseWorkerResponse,
} from "./analyseTrack.worker";

// Runs the track analysis in a Web Worker so the multi-pass DSP
// (onset envelope, tempo autocorrelation, key and vocal detection)
// never blocks the UI thread — the freeze the first-open test felt
// every time the DJ session prepared a song.
//
// Requests are HELD in this runner and dispatched to the worker
// one at a time, fast passes before deep ones (Note 29): the
// worker is serial anyway, so posting everything the moment it
// arrives only decides the order by accident of arrival — and a
// deep pass posted microseconds before a fast one then blocks the
// fast answer behind seconds of DSP the listener is waiting on.
// Dispatch is scheduled on a microtask so a synchronous burst of
// requests is sorted as a burst. The wedge timeout measures from
// DISPATCH, not from enqueue: time spent queued is the priority
// discipline working, not a wedge.
//
// The failure discipline is null, never inline (Note 29): if the
// worker errors or wedges, every unsettled request resolves null
// — every caller already treats null as a first-class outcome
// (fast-null → playable shell + background deepen; deep-null →
// the fast analysis stays) — and the worker is retired WITHOUT
// poisoning the run: the next dispatch constructs a fresh one.
// The inline DSP path remains only for the environment that
// cannot construct a worker at all, and there it serves one
// request at a time, never a queue drained synchronously.
// Samples are posted without transfer, so the caller's copy
// survives for exactly that fallback — a structured clone of the
// samples is a memcpy, trivial next to seconds of DSP.

/** Far beyond any real analysis; a worker slower than this is wedged, not busy. */
const WORKER_TIMEOUT_MS = 120_000;

interface QueuedAnalysis {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  options: AnalyseOptions;
  resolve: (analysis: TrackAnalysis | null) => void;
}

interface InFlightAnalysis extends QueuedAnalysis {
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
/**
 * Latched only by the one fact that cannot change mid-run — the
 * environment has no Worker global at all. A construction THROW
 * does not latch: the next dispatch tries a fresh construction.
 */
let workerUnsupported = false;
let nextRequestId = 1;
const queue: QueuedAnalysis[] = [];
let inFlight: InFlightAnalysis | null = null;
let dispatchScheduled = false;

function runInline(entry: QueuedAnalysis): TrackAnalysis | null {
  try {
    return analyseTrack(entry.samples, entry.sampleRate, entry.options);
  } catch {
    return null;
  }
}

/**
 * Retires the current worker and settles every unsettled request
 * — the one in flight and everything queued — with null. The
 * retirement is not a poisoning: the next dispatch constructs a
 * fresh worker, so one failure costs the requests it interrupted,
 * not the rest of the run.
 */
function retireWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  if (inFlight) {
    clearTimeout(inFlight.timer);
    inFlight.resolve(null);
    inFlight = null;
  }
  for (const entry of queue.splice(0)) {
    entry.resolve(null);
  }
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (workerUnsupported) return null;
  if (typeof Worker === "undefined") {
    workerUnsupported = true;
    return null;
  }
  try {
    worker = new AnalyseWorker();
  } catch {
    return null;
  }
  worker.onmessage = (event: MessageEvent<AnalyseWorkerResponse>) => {
    if (!inFlight || event.data.id !== inFlight.id) return;
    const done = inFlight;
    inFlight = null;
    clearTimeout(done.timer);
    done.resolve(event.data.analysis);
    dispatchNext();
  };
  worker.onerror = () => retireWorker();
  return worker;
}

function scheduleDispatch(): void {
  if (dispatchScheduled) return;
  dispatchScheduled = true;
  void Promise.resolve().then(() => {
    dispatchScheduled = false;
    dispatchNext();
  });
}

/**
 * Dispatches the next held request: the first FAST pass in the
 * queue, else the queue's head (FIFO within a class). One request
 * is ever in flight — the worker is serial, and holding the rest
 * here is what lets a fast pass overtake queued deep passes
 * instead of waiting behind every one of them.
 */
function dispatchNext(): void {
  while (!inFlight && queue.length > 0) {
    let index = queue.findIndex(
      (entry) => (entry.options.depth ?? "deep") === "fast",
    );
    if (index < 0) index = 0;
    const [entry] = queue.splice(index, 1);
    const active = ensureWorker();
    if (!active) {
      // No worker can be had in this environment: this one
      // request runs inline — its own fallback, on its own —
      // and the next held request is considered on its own turn.
      entry.resolve(runInline(entry));
      continue;
    }
    const timer = setTimeout(() => {
      // A wedged worker must not stall preparation forever:
      // retire it (the in-flight request settles null with
      // everything queued) and let the next dispatch rebuild.
      retireWorker();
    }, WORKER_TIMEOUT_MS);
    inFlight = { ...entry, timer };
    const request: AnalyseWorkerRequest = {
      id: entry.id,
      samples: entry.samples,
      sampleRate: entry.sampleRate,
      options: entry.options,
    };
    try {
      active.postMessage(request);
    } catch {
      retireWorker();
    }
  }
}

function analyseInWorker(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyseOptions,
): Promise<TrackAnalysis | null> {
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve) => {
    queue.push({ id, samples, sampleRate, options, resolve });
    scheduleDispatch();
  });
}

/**
 * Analyses mono samples off the UI thread when a worker is
 * available, inline when it is not — the result is identical either
 * way, only the thread differs. This is the same worker protocol as
 * `analyseBufferOffThread`; it exists for callers that already hold
 * the mono samples (the analysis cache fingerprints them before
 * deciding whether an analysis is needed at all).
 */
export async function analyseSamplesOffThread(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyseOptions = {},
): Promise<TrackAnalysis | null> {
  return analyseInWorker(samples, sampleRate, options);
}

/**
 * Analyses a decoded track off the UI thread when a worker is
 * available, inline when it is not — the result is identical either
 * way, only the thread differs.
 */
export async function analyseBufferOffThread(
  buffer: AudioBuffer,
  options: AnalyseOptions = {},
): Promise<TrackAnalysis | null> {
  const samples = mixdownToMono(buffer);
  return analyseSamplesOffThread(samples, buffer.sampleRate, options);
}
