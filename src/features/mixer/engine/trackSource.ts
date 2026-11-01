import { linerDb } from "@/shared/storage";
import type { Track } from "@/shared/types";
import { resolvePlaybackStream } from "../../player/engine/streamResolver";
import { analyseAudioBuffer, type TrackAnalysis } from "./analyseTrack";

// Where the DJ session gets its music. The mixer cannot work with a
// stream that is still arriving — it needs the whole track, decoded,
// before a blend can be planned. Liner already downloads whole tracks
// into its audio cache ahead of playback; this module rides on that:
//
// 1. a track the player has already cached is read straight from the
//    cache as a blob;
// 2. otherwise its stream is resolved the same way the player resolves
//    it and downloaded in full;
// 3. the blob is decoded to raw audio and analysed once; both the
//    decoded audio and the analysis are kept in memory per track, so
//    asking again during the same session is free.
//
// Returns null when a track cannot be obtained in full — the session
// treats such a track as unmixable and skips it rather than stalling.

export interface PreparedTrack {
  track: Track;
  buffer: AudioBuffer;
  analysis: TrackAnalysis;
}

const prepared = new Map<string, PreparedTrack>();
const inFlight = new Map<string, Promise<PreparedTrack | null>>();

let decodeContext: OfflineAudioContext | null = null;

function decoder(): OfflineAudioContext {
  if (!decodeContext) {
    decodeContext = new OfflineAudioContext(2, 1, 44100);
  }
  return decodeContext;
}

async function fetchBlob(track: Track): Promise<Blob | null> {
  const cached = await linerDb.getAudio(track.id);
  if (cached && cached.blob && cached.blob.size > 0) {
    return cached.blob;
  }
  const stream = await resolvePlaybackStream(track);
  if (stream.blob) return stream.blob;
  if (stream.url) {
    const response = await fetch(stream.url);
    if (!response.ok) return null;
    return response.blob();
  }
  return null;
}

async function prepare(track: Track): Promise<PreparedTrack | null> {
  try {
    const blob = await fetchBlob(track);
    if (!blob) return null;
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = await decoder().decodeAudioData(arrayBuffer);
    const analysis = analyseAudioBuffer(buffer);
    if (!analysis) return null;
    const result: PreparedTrack = { track, buffer, analysis };
    prepared.set(track.id, result);
    return result;
  } catch {
    return null;
  }
}

export function loadTrackForMixing(
  track: Track,
): Promise<PreparedTrack | null> {
  const done = prepared.get(track.id);
  if (done) return Promise.resolve(done);
  const pending = inFlight.get(track.id);
  if (pending) return pending;
  const promise = prepare(track).finally(() => {
    inFlight.delete(track.id);
  });
  inFlight.set(track.id, promise);
  return promise;
}

export function preparedTrack(trackId: string): PreparedTrack | undefined {
  return prepared.get(trackId);
}
