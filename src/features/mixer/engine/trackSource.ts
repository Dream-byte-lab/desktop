import { linerDb } from "@/shared/storage";
import type { Track } from "@/shared/types";
import { resolvePlaybackStream } from "../../player/engine/streamResolver";
import {
  audioFingerprint,
  mixdownToMono,
  type TrackAnalysis,
} from "./analyseTrack";
import { analyseSamplesOffThread } from "./analyseTrackRunner";
import { getCachedAnalysis, putCachedAnalysis } from "./analysisCache";

// Where the DJ session gets its music. The mixer cannot work with a
// stream that is still arriving — it needs the whole track, decoded,
// before a blend can be planned. Liner already downloads whole tracks
// into its audio cache ahead of playback; this module rides on that:
//
// 1. a track the player has already cached is read straight from the
//    cache as a blob;
// 2. otherwise its stream is resolved the same way the player resolves
//    it and downloaded in full;
// 3. the blob is decoded to raw audio and analysed; both the decoded
//    audio and the analysis are kept per track, so asking again
//    during the same session is free.
//
// Returns null when a track cannot be obtained in full — the session
// treats such a track as unmixable and skips it rather than stalling.
//
// Step 5 (slice S5-1) changes what "analysed" costs, in three ways:
//
// - THE ANALYSIS CACHE. The decoded audio is fingerprinted before
//   any analysis runs; a stored analysis whose version and
//   fingerprint match this audio is served straight from the cache
//   (analysisCache.ts) and no worker call happens at all. A track is
//   analysed at most once per audio version, ever — across sessions,
//   not just within one.
// - PROGRESSIVE DEPTH. A cache miss is answered with the FAST
//   analysis (sufficient for the imminent pair) and the DEEP
//   analysis completes in the worker behind it, replacing the fast
//   one on the same PreparedTrack object when it lands — a session
//   holding the object reads the deepened analysis at its next
//   decision, because it reads `.analysis` when it decides, not when
//   the track was prepared. Preparation therefore stays a one-track
//   horizon: prepare the next track, deepen it in the background —
//   never analyse the whole queue tail "just in case".
// - A BOUNDED BUFFER CACHE. V1 kept every decoded buffer forever
//   (Note 7's memory-pressure suspect; v2's per-track data is
//   bigger). The prepared map now holds at most MAX_PREPARED
//   tracks, least-recently-used first out. Eviction only drops this
//   module's reference — a session holding a PreparedTrack keeps
//   using it, and re-asking for an evicted track is cheap because
//   its analysis comes back from the cache.

export interface PreparedTrack {
  track: Track;
  buffer: AudioBuffer;
  analysis: TrackAnalysis;
}

/** Decoded buffers kept warm at once: current + next + one beyond, plus slack. */
const MAX_PREPARED = 4;

const prepared = new Map<string, PreparedTrack>();
const inFlight = new Map<string, Promise<PreparedTrack | null>>();

function rememberPrepared(entry: PreparedTrack): void {
  prepared.delete(entry.track.id);
  prepared.set(entry.track.id, entry);
  while (prepared.size > MAX_PREPARED) {
    const oldest = prepared.keys().next().value;
    if (oldest === undefined) break;
    prepared.delete(oldest);
  }
}

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

/**
 * The deep pass, completed behind a fast answer: when it lands, the
 * cache is upgraded and — if this exact prepared entry is still the
 * one the module holds — its analysis is replaced in place.
 */
async function deepen(
  entry: PreparedTrack,
  samples: Float32Array,
  sampleRate: number,
): Promise<void> {
  try {
    const deep = await analyseSamplesOffThread(samples, sampleRate, {
      depth: "deep",
    });
    if (!deep) return;
    await putCachedAnalysis(entry.track.id, deep);
    if (prepared.get(entry.track.id) === entry) {
      entry.analysis = deep;
    }
  } catch {
    // A failed deepening leaves the fast analysis in place — it was
    // always a complete answer, just a shallower one.
  }
}

async function prepare(track: Track): Promise<PreparedTrack | null> {
  try {
    const blob = await fetchBlob(track);
    if (!blob) return null;
    const arrayBuffer = await blob.arrayBuffer();
    const buffer = await decoder().decodeAudioData(arrayBuffer);
    const samples = mixdownToMono(buffer);
    const audioHash = audioFingerprint(samples, buffer.sampleRate);

    const cached = await getCachedAnalysis(track.id, audioHash);
    if (cached && cached.depth === "deep") {
      const result: PreparedTrack = {
        track,
        buffer,
        analysis: cached.analysis,
      };
      rememberPrepared(result);
      return result;
    }

    let fast = cached?.analysis ?? null;
    if (!fast) {
      fast = await analyseSamplesOffThread(samples, buffer.sampleRate, {
        depth: "fast",
      });
      if (!fast) return null;
      void putCachedAnalysis(track.id, fast);
    }
    const result: PreparedTrack = { track, buffer, analysis: fast };
    rememberPrepared(result);
    void deepen(result, samples, buffer.sampleRate);
    return result;
  } catch {
    return null;
  }
}

export function loadTrackForMixing(
  track: Track,
): Promise<PreparedTrack | null> {
  const done = prepared.get(track.id);
  if (done) {
    rememberPrepared(done);
    return Promise.resolve(done);
  }
  const pending = inFlight.get(track.id);
  if (pending) return pending;
  const promise = prepare(track).finally(() => {
    inFlight.delete(track.id);
  });
  inFlight.set(track.id, promise);
  return promise;
}

export function preparedTrack(trackId: string): PreparedTrack | undefined {
  const entry = prepared.get(trackId);
  if (entry) rememberPrepared(entry);
  return entry;
}
