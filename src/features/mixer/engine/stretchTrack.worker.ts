import { stretchWithSoundTouch } from "./timeStretch";

// The stretch worker: renders a pitch-preserved rendition of a
// track (SoundTouch, quickSeek — the production default the S5-5
// spike's meters chose: identical quality on the fixtures at a
// fraction of the cost) off the UI thread, so preparing a stretched
// join never freezes the interface. It receives the track's channel
// arrays and answers with the rendered channels (or null, the
// renderer's own failure verdict).
//
// Protocol: requests carry an id; replies carry the same id, so
// overlapping renditions never cross their answers. Mirrors
// analyseTrack.worker.ts exactly.

export interface StretchWorkerRequest {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  /** The tempo factor k: output duration = input duration / k. */
  factor: number;
}

export interface StretchWorkerResponse {
  id: number;
  channels: Float32Array[] | null;
}

self.onmessage = (event: MessageEvent<StretchWorkerRequest>) => {
  const { id, channels, sampleRate, factor } = event.data;
  let rendered: Float32Array[] | null = null;
  try {
    rendered = stretchWithSoundTouch(channels, sampleRate, factor, {
      quickSeek: true,
    });
  } catch {
    rendered = null;
  }
  const response: StretchWorkerResponse = { id, channels: rendered };
  self.postMessage(response);
};
