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
import { stretchChannelsOffThread } from "./stretchTrackRunner";

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
// Returns null when a track cannot be obtained in full — the audio
// itself could not be downloaded or decoded, so nothing can play
// it. A track that decodes but cannot be ANALYSED in time is a
// different case (Note 20): it comes back as a playable shell
// (mixable: false) — playable plainly, never blended — and the
// analysis upgrades it in place when it lands in the background.
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
//   the track was prepared. Note 20 adds the shell to the same
//   pattern: an analysis that fails or outlasts ANALYSIS_WAIT_MS
//   answers as a playable shell (mixable: false) and is upgraded in
//   place when the real analysis lands behind it. Analysis is still
//   never run over the whole queue tail "just in case".
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
  /**
   * Whether the analysis is real and the track may be blended.
   * Absent means mixable (every preparation before Note 20, and the
   * test fixtures that build PreparedTracks by hand). A track that
   * decoded but could not be analysed in time is prepared with
   * mixable: false and a shell analysis (see unanalysedShell): it
   * can be PLAYED plainly, and the session must never author a
   * blend into or out of it.
   */
  mixable?: boolean;
}

/**
 * How long preparation waits for the fast analysis before answering
 * with a playable shell instead. The session's own preparation
 * deadline is 45 s; the shell must arrive well inside it, or the
 * session would (rightly) count the track as failed. A healthy fast
 * pass lands in a small fraction of this.
 */
export const ANALYSIS_WAIT_MS = 15_000;

/**
 * Decoded buffers kept warm at once: the sounding track, its join
 * partner while a blend sounds, the two preparation-horizon slots
 * (Note 20), plus one of slack for landing churn — a join lands the
 * incoming and promotes the second slot while the outgoing's entry
 * is still referenced.
 */
const MAX_PREPARED = 5;

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
  // Note 29: do not spend a deep pass on an entry the bounded
  // prepared map has already evicted — under heavy preparation an
  // entry can churn out between its preparation and this call
  // (the fast-landing continuations above call deepen late). The
  // landing check below has always guarded the write; this start
  // check saves the worker pass itself.
  if (prepared.get(entry.track.id) !== entry) return;
  try {
    const deep = await analyseSamplesOffThread(samples, sampleRate, {
      depth: "deep",
    });
    if (!deep) return;
    await putCachedAnalysis(entry.track.id, deep);
    if (prepared.get(entry.track.id) === entry) {
      entry.analysis = deep;
      entry.mixable = true;
    }
  } catch {
    // A failed deepening leaves the fast analysis in place — it was
    // always a complete answer, just a shallower one.
  }
}

/**
 * The shell analysis for a track that decoded but could not be
 * analysed in time. What it claims is MEASURED from the decoded
 * audio — the whole-track loudness (RMS) and the per-second energy
 * curve (RMS, normalised) are true numbers, and they are all the
 * session's plain playback of the track ever reads (level-matching
 * only). Everything musical is EMPTY, not estimated: no tempo, no
 * key, no drops, no vocal ranges. The entry's mixable: false is the
 * contract that keeps every consumer from reading musical meaning
 * into it, and the shell is never written to the analysis cache.
 */
function unanalysedShell(
  buffer: AudioBuffer,
  samples: Float32Array,
): TrackAnalysis {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    sumSquares += samples[i] * samples[i];
  }
  const loudness =
    samples.length > 0 ? Math.sqrt(sumSquares / samples.length) : 0;

  const perSecond = Math.max(1, Math.floor(buffer.sampleRate));
  const energyCurve: { timeSec: number; energy: number }[] = [];
  let peak = 0;
  for (let start = 0; start < samples.length; start += perSecond) {
    const end = Math.min(samples.length, start + perSecond);
    let windowSquares = 0;
    for (let i = start; i < end; i += 1) {
      windowSquares += samples[i] * samples[i];
    }
    const rms = Math.sqrt(windowSquares / Math.max(1, end - start));
    if (rms > peak) peak = rms;
    energyCurve.push({ timeSec: start / buffer.sampleRate, energy: rms });
  }
  for (const point of energyCurve) {
    point.energy = peak > 0 ? point.energy / peak : 0;
  }

  return {
    beatMap: {
      bpm: 0,
      firstBeatSec: 0,
      beatsPerBar: 4,
      durationSec: buffer.duration,
    },
    tempoConfidence: 0,
    energyCurve,
    drops: [],
    key: null,
    vocalRanges: [],
    loudness,
  };
}

const ANALYSIS_TIMED_OUT = Symbol("analysis-timed-out");

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
        mixable: true,
      };
      rememberPrepared(result);
      return result;
    }

    let fast = cached?.analysis ?? null;
    if (!fast) {
      const fastPromise = analyseSamplesOffThread(samples, buffer.sampleRate, {
        depth: "fast",
      }).catch(() => null);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const raced = await Promise.race([
        fastPromise,
        new Promise<typeof ANALYSIS_TIMED_OUT>((resolve) => {
          timer = setTimeout(
            () => resolve(ANALYSIS_TIMED_OUT),
            ANALYSIS_WAIT_MS,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (raced === ANALYSIS_TIMED_OUT || raced === null) {
        // The audio is here and playable; only the analysis is
        // missing or late. Answer with the shell now and let the
        // analysis upgrade this very entry when it lands — the
        // fast promise keeps running after a timeout, and a failed
        // fast pass gets the deep pass as its background attempt
        // (deepen upgrades in place and flips mixable when it
        // lands; if neither lands, the shell stays a shell).
        const shell: PreparedTrack = {
          track,
          buffer,
          analysis: unanalysedShell(buffer, samples),
          mixable: false,
        };
        rememberPrepared(shell);
        if (raced === ANALYSIS_TIMED_OUT) {
          void fastPromise.then((landed) => {
            if (!landed) {
              void deepen(shell, samples, buffer.sampleRate);
              return;
            }
            void putCachedAnalysis(track.id, landed);
            if (prepared.get(track.id) === shell) {
              shell.analysis = landed;
              shell.mixable = true;
            }
            void deepen(shell, samples, buffer.sampleRate);
          });
        } else {
          void deepen(shell, samples, buffer.sampleRate);
        }
        return shell;
      }
      fast = raced;
      void putCachedAnalysis(track.id, fast);
    }
    const result: PreparedTrack = {
      track,
      buffer,
      analysis: fast,
      mixable: true,
    };
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

// ---------------------------------------------------------------------
// Pitch-preserved renditions (the stretch integration)
//
// A recipe whose overlap carries stretchB is performed against a
// RENDITION of the incoming track: the whole track rendered at the
// recipe's tempo factor, pitch preserved (timeStretch.ts's
// SoundTouch renderer, run off-thread by stretchTrackRunner.ts).
// The rendition is a second decoded buffer for the same track, so
// it gets its own bounded cache under the same LRU discipline as
// the prepared cache — deliberately smaller: a session only ever
// needs the live pair's rendition (the incoming of the join being
// planned), plus the one just played out. Two slots cover both;
// a third render evicts the eldest. Eviction drops only this
// module's reference — a deck already playing a rendition keeps it.
//
// Rendering is requested by the SESSION when a decision first calls
// for it (the decision window opens up to 150 s before the anchor),
// never speculatively at preparation: most pairs never stretch, and
// an unneeded full-track render is exactly the ARM cost this design
// exists to avoid.
// ---------------------------------------------------------------------

/** Renditions kept at once: the live pair's, plus the one just played. */
const MAX_RENDITIONS = 2;

const renditions = new Map<string, AudioBuffer>();
const renditionInFlight = new Map<string, Promise<AudioBuffer | null>>();

function renditionKey(trackId: string, factor: number): string {
  return `${trackId}@${factor.toFixed(4)}`;
}

function rememberRendition(key: string, buffer: AudioBuffer): void {
  renditions.delete(key);
  renditions.set(key, buffer);
  while (renditions.size > MAX_RENDITIONS) {
    const oldest = renditions.keys().next().value;
    if (oldest === undefined) break;
    renditions.delete(oldest);
  }
}

/** The cached rendition for a track at a factor, when one is ready. */
export function stretchRendition(
  trackId: string,
  factor: number,
): AudioBuffer | undefined {
  const key = renditionKey(trackId, factor);
  const buffer = renditions.get(key);
  if (buffer) rememberRendition(key, buffer);
  return buffer;
}

async function renderRendition(
  prepared: PreparedTrack,
  factor: number,
): Promise<AudioBuffer | null> {
  try {
    const source = prepared.buffer;
    // The channel views are read-only for everyone downstream: the
    // runner posts a structured clone to the worker, and its inline
    // fallback only reads. The decoded buffer is never mutated.
    const channels: Float32Array[] = [];
    for (let i = 0; i < source.numberOfChannels; i += 1) {
      channels.push(source.getChannelData(i));
    }
    const rendered = await stretchChannelsOffThread(
      channels,
      source.sampleRate,
      factor,
    );
    if (!rendered || rendered.length === 0 || rendered[0].length === 0) {
      return null;
    }
    const buffer = decoder().createBuffer(
      rendered.length,
      rendered[0].length,
      source.sampleRate,
    );
    for (let i = 0; i < rendered.length; i += 1) {
      buffer.copyToChannel(new Float32Array(rendered[i]), i);
    }
    rememberRendition(renditionKey(prepared.track.id, factor), buffer);
    return buffer;
  } catch {
    return null;
  }
}

/**
 * The rendition of a prepared track at a tempo factor, rendered on
 * first ask and cached after. Concurrent asks share one render.
 * Returns null when the factor is not a rendition factor (1, or
 * outside the performable rate range) or the render failed — the
 * caller treats a null as "no rendition", never as a stall: the
 * session's fallback floor covers a join whose rendition is missing.
 */
export function loadStretchRendition(
  prepared: PreparedTrack,
  factor: number,
): Promise<AudioBuffer | null> {
  if (!Number.isFinite(factor) || factor === 1 || factor < 0.5 || factor > 2) {
    return Promise.resolve(null);
  }
  const key = renditionKey(prepared.track.id, factor);
  const done = renditions.get(key);
  if (done) {
    rememberRendition(key, done);
    return Promise.resolve(done);
  }
  const pending = renditionInFlight.get(key);
  if (pending) return pending;
  const promise = renderRendition(prepared, factor).finally(() => {
    renditionInFlight.delete(key);
  });
  renditionInFlight.set(key, promise);
  return promise;
}
