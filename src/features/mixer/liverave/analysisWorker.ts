// analysisWorker.ts — Web Worker entry for the fresh analyser.
//
// Same Vite worker idiom as the repo's surviving workers (compare
// src/shared/api/proofOfWork.worker.ts): the runner imports this
// module with `?worker&inline`, and this file answers sample
// buffers with TrackReads by calling the environment-pure
// analyseSamples. One message = one analysis; sequencing and
// queue discipline live in analysisRunner.ts, not here.

import { analyseSamples } from "./analyse";
import type { AnalysisDepth, TrackRead } from "./facts";

export interface AnalysisWorkerRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  depth: AnalysisDepth;
}

export type AnalysisWorkerResponse =
  | { id: number; ok: true; read: TrackRead | null }
  | { id: number; ok: false; message: string };

self.onmessage = (event: MessageEvent<AnalysisWorkerRequest>) => {
  const { id, samples, sampleRate, depth } = event.data;
  try {
    const read = analyseSamples(samples, sampleRate, { depth });
    const reply: AnalysisWorkerResponse = { id, ok: true, read };
    self.postMessage(reply);
  } catch (error) {
    const reply: AnalysisWorkerResponse = {
      id,
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(reply);
  }
};
