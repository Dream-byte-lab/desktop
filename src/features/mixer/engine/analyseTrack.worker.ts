import {
  analyseTrack,
  type AnalyseOptions,
  type TrackAnalysis,
} from "./analyseTrack";

// The analysis worker: runs the analyser's multi-pass DSP (onset
// envelope, tempo autocorrelation, key and vocal detection) off the
// UI thread, so preparing a track for the DJ session never freezes
// the interface. It receives mono samples — the cheap mixdown stays
// on the caller side — and answers with the finished analysis (or
// null, the analyser's own "cannot read this track" verdict).
//
// Protocol: requests carry an id; replies carry the same id, so
// overlapping preparations never cross their answers.

export interface AnalyseWorkerRequest {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  options: AnalyseOptions;
}

export interface AnalyseWorkerResponse {
  id: number;
  analysis: TrackAnalysis | null;
}

self.onmessage = (event: MessageEvent<AnalyseWorkerRequest>) => {
  const { id, samples, sampleRate, options } = event.data;
  let analysis: TrackAnalysis | null = null;
  try {
    analysis = analyseTrack(samples, sampleRate, options);
  } catch {
    analysis = null;
  }
  const response: AnalyseWorkerResponse = { id, analysis };
  self.postMessage(response);
};
