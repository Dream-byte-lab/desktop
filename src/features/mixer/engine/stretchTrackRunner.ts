import StretchWorker from "./stretchTrack.worker?worker&inline";
import { stretchWithSoundTouch } from "./timeStretch";
import type {
  StretchWorkerRequest,
  StretchWorkerResponse,
} from "./stretchTrack.worker";

// Runs pitch-preserving rendition renders in a Web Worker so the
// SoundTouch DSP never blocks the UI thread — the same discipline
// as analyseTrackRunner.ts, mirrored. The failure discipline is
// null, never inline (Note 29): if the worker errors or wedges,
// every outstanding render resolves null — the caller treats null
// as "no rendition" and the session falls back a floor — and the
// worker is retired WITHOUT poisoning the run: the next request
// constructs a fresh one. The inline render remains only for the
// environment that cannot construct a worker at all, serving one
// request at a time. Channels are posted without transfer, so the
// caller's arrays survive for exactly that fallback — a structured
// clone is a memcpy, trivial next to seconds of DSP.
//
// The production render is quickSeek (the S5-5 spike's verdict:
// identical quality on the fixtures at ~12× less cost than the
// quality search on this machine's measurements).

/** Far beyond any real render; a worker slower than this is wedged, not busy. */
const WORKER_TIMEOUT_MS = 120_000;

interface PendingStretch {
  channels: Float32Array[];
  sampleRate: number;
  factor: number;
  resolve: (channels: Float32Array[] | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

let worker: Worker | null = null;
/**
 * Latched only by the one fact that cannot change mid-run — the
 * environment has no Worker global at all. A construction THROW
 * does not latch: the next request tries a fresh construction.
 */
let workerUnsupported = false;
let nextRequestId = 1;
const pending = new Map<number, PendingStretch>();

function runInline(
  entry: Omit<PendingStretch, "resolve" | "timer">,
): Float32Array[] | null {
  try {
    return stretchWithSoundTouch(
      entry.channels,
      entry.sampleRate,
      entry.factor,
      {
        quickSeek: true,
      },
    );
  } catch {
    return null;
  }
}

/**
 * Retires the current worker and settles every outstanding
 * request with null — never by running the render inline on the
 * UI thread. The retirement is not a poisoning: the next request
 * constructs a fresh worker, so one failure costs the renders it
 * interrupted, not the rest of the run.
 */
function retireWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve(null);
  }
  pending.clear();
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (workerUnsupported) return null;
  if (typeof Worker === "undefined") {
    workerUnsupported = true;
    return null;
  }
  try {
    worker = new StretchWorker();
  } catch {
    return null;
  }
  worker.onmessage = (event: MessageEvent<StretchWorkerResponse>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    clearTimeout(entry.timer);
    entry.resolve(event.data.channels);
  };
  worker.onerror = () => retireWorker();
  return worker;
}

function stretchInWorker(
  channels: Float32Array[],
  sampleRate: number,
  factor: number,
): Promise<Float32Array[] | null> | null {
  const active = ensureWorker();
  if (!active) return null;
  const id = nextRequestId;
  nextRequestId += 1;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // A wedged worker must not stall rendition forever: retire
      // it — this request settles null with everything outstanding
      // — and let the next request rebuild.
      retireWorker();
    }, WORKER_TIMEOUT_MS);
    pending.set(id, { channels, sampleRate, factor, resolve, timer });
    const request: StretchWorkerRequest = { id, channels, sampleRate, factor };
    try {
      active.postMessage(request);
    } catch {
      retireWorker();
    }
  });
}

/**
 * Renders channel arrays to `factor` × the tempo, pitch preserved,
 * off the UI thread when a worker is available, inline when it is
 * not — the result is identical either way, only the thread differs.
 * Returns the rendered channels (exactly round(inputLength / factor)
 * frames each), or null when the render failed.
 */
export async function stretchChannelsOffThread(
  channels: Float32Array[],
  sampleRate: number,
  factor: number,
): Promise<Float32Array[] | null> {
  const fromWorker = stretchInWorker(channels, sampleRate, factor);
  if (fromWorker) return fromWorker;
  return runInline({ channels, sampleRate, factor });
}
