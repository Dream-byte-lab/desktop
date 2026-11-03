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
// The fallback is a promise, not a hope: if the worker cannot be
// constructed, errors out, or wedges, the same analysis runs inline
// on the spot and the caller never knows the difference. Samples are
// posted without transfer, so the caller's copy survives for exactly
// that fallback — a structured clone of the samples is a memcpy,
// trivial next to seconds of DSP.

/** Far beyond any real analysis; a worker slower than this is wedged, not busy. */
const WORKER_TIMEOUT_MS = 120_000;

interface PendingAnalysis {
  samples: Float32Array;
  sampleRate: number;
  options: AnalyseOptions;
  resolve: (analysis: TrackAnalysis | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
let workerBroken = false;
let nextRequestId = 1;
const pending = new Map<number, PendingAnalysis>();

function runInline(entry: Omit<PendingAnalysis, "resolve" | "timer">) {
  try {
    return analyseTrack(entry.samples, entry.sampleRate, entry.options);
  } catch {
    return null;
  }
}

/** Settles every outstanding request inline and retires the worker for good. */
function retireWorker(): void {
  workerBroken = true;
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve(runInline(entry));
  }
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    workerBroken = true;
    return null;
  }
  try {
    worker = new AnalyseWorker();
  } catch {
    workerBroken = true;
    return null;
  }
  worker.onmessage = (event: MessageEvent<AnalyseWorkerResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    clearTimeout(entry.timer);
    entry.resolve(event.data.analysis);
  };
  worker.onerror = () => retireWorker();
  return worker;
}

function analyseInWorker(
  samples: Float32Array,
  sampleRate: number,
  options: AnalyseOptions,
): Promise<TrackAnalysis | null> | null {
  const active = ensureWorker();
  if (!active) return null;
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // A wedged worker must not stall preparation forever: settle
      // this request inline and stop trusting the worker at all.
      pending.delete(id);
      retireWorker();
      resolve(runInline({ samples, sampleRate, options }));
    }, WORKER_TIMEOUT_MS);
    pending.set(id, { samples, sampleRate, options, resolve, timer });
    const request: AnalyseWorkerRequest = { id, samples, sampleRate, options };
    try {
      active.postMessage(request);
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      retireWorker();
      resolve(runInline({ samples, sampleRate, options }));
    }
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
  const fromWorker = analyseInWorker(samples, sampleRate, options);
  if (fromWorker) return fromWorker;
  return runInline({ samples, sampleRate, options });
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
