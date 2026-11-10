// source.ts — track → decoded audio for the liveRave session
// (Wave 2D). Thin and honest: it mirrors the plain player's own
// track→bytes resolution (the surviving loading path in
// playerRuntime / streamResolver) and decodes on the performer's
// AudioContext. Resolution failures return null — this module
// never throws into the session.
//
// The player's resolution order, mirrored:
//   1. the linerDb audio cache (a saved/downloaded blob), when the
//      cached blob is a non-empty audio blob;
//   2. resolvePlaybackStream(track) — local file URL / saved-track
//      URL / SoundCloud / liner (R2) / YouTube resolution — whose
//      result is either a Blob or a URL to fetch.
// Bytes are decoded with decodeAudioData on the injected context
// (the performer's context, via its master analyser), and the
// mono mixdown for analysis is (L + R) / 2 via analyse.ts's
// mixdownToMono (a single-channel buffer is used as-is).
//
// THE ATTRIBUTION BRIDGE lives here, by design: this resolution
// is the one moment in the engine where a player track (its id)
// and its actual decoded audio (the samples the fingerprint is
// taken over) are in the same hands. The analysis store is
// content-addressed by audioHash and a TrackRead carries no track
// id — deliberately — so without a bridge, enumeration consumers
// (the For You feed) can list reads but never attribute them to
// tracks. On every successful resolution this module computes the
// fingerprint with the SAME audioFingerprint supply.ts will use
// (identity therefore agrees by construction, not by copy) and
// records (trackId → audioHash) into storage.ts's bridge store.
// Recording is best-effort: a bridge failure must never cost the
// session its audio, and an unresolved track records nothing.

import type { Track } from "@/shared/types";
import { linerDb } from "@/shared/storage";
import {
  RESOLVE_TIMEOUT_MS,
  resolvePlaybackStream,
} from "@/features/player/engine/streamResolver";
import { audioFingerprint, mixdownToMono } from "./analyse";
import { recordTrackHash } from "./storage";

export interface ResolvedTrackAudio {
  /** Mono mixdown of the decoded buffer, for analysis. */
  samples: Float32Array;
  sampleRate: number;
  /** The decoded buffer itself, for the performer's decks. */
  buffer: AudioBuffer;
  /**
   * The content fingerprint of the samples above — the identity
   * the analysis store keys this track's reads under, and the
   * value recorded in the attribution bridge for this track.
   */
  audioHash: string;
}

/** The slice of a BaseAudioContext source.ts needs. */
export interface DecodeContext {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

export interface TrackSourceDeps {
  /** The performer's context (decode happens on the deck's clock). */
  getContext: () => DecodeContext | null;
  /** Track → encoded bytes. Injected for tests; default mirrors the player. */
  fetchBytes?: (track: Track) => Promise<ArrayBuffer | null>;
  /**
   * The attribution-bridge write: (trackId, audioHash) recorded
   * when a track's audio resolves. Injected for tests; the default
   * is storage.ts's bridge store.
   */
  recordAttribution?: (
    trackId: string,
    audioHash: string,
  ) => Promise<void> | void;
}

export interface TrackSource {
  resolveTrackAudio(track: Track): Promise<ResolvedTrackAudio | null>;
}

/**
 * The default byte fetcher: the player's own resolution path
 * (cache first, then the stream resolver). Never throws.
 */
export async function fetchTrackBytes(
  track: Track,
): Promise<ArrayBuffer | null> {
  try {
    const cached = await linerDb.getAudio(track.id).catch(() => null);
    const blob = cached?.blob;
    if (
      blob &&
      blob.size > 0 &&
      (!blob.type || blob.type.startsWith("audio/"))
    ) {
      return await blob.arrayBuffer();
    }
  } catch {
    // A cache failure must not lose the stream path.
  }
  try {
    // Mirror the player's own call exactly: progressive resolution,
    // which carries the resolver's 25 s bound (withResolveTimeout).
    // The DJ used to resolve non-progressively with no bound at
    // all, so a streamed preparation could wait forever where plain
    // playback would have failed, named, in 25 s.
    const stream = await resolvePlaybackStream(track, undefined, {
      progressive: true,
    });
    if (stream.blob) {
      return await stream.blob.arrayBuffer();
    }
    if (stream.url) {
      // The whole-file fetch gets the same bound as the resolve:
      // a streamed preparation either completes inside it or
      // settles as a (named, upstream) resolution failure — it
      // never hangs unbounded.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
      try {
        const response = await fetch(stream.url, {
          signal: controller.signal,
        });
        if (!response.ok) return null;
        return await response.arrayBuffer();
      } finally {
        clearTimeout(timer);
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Mono mixdown of a decoded buffer (decoder discipline, §3.0). */
export function samplesOfBuffer(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels <= 1) {
    return buffer.getChannelData(0).slice();
  }
  return mixdownToMono(buffer.getChannelData(0), buffer.getChannelData(1));
}

export function createTrackSource(deps: TrackSourceDeps): TrackSource {
  const fetchBytes = deps.fetchBytes ?? fetchTrackBytes;
  const recordAttribution = deps.recordAttribution ?? recordTrackHash;

  async function resolveTrackAudio(
    track: Track,
  ): Promise<ResolvedTrackAudio | null> {
    if (!track || typeof track.id !== "string" || track.id.length === 0) {
      return null;
    }
    let context: DecodeContext | null = null;
    try {
      context = deps.getContext();
    } catch {
      context = null;
    }
    if (!context) return null;
    let bytes: ArrayBuffer | null = null;
    try {
      bytes = await fetchBytes(track);
    } catch {
      return null;
    }
    if (!bytes || bytes.byteLength === 0) return null;
    let buffer: AudioBuffer;
    try {
      // decodeAudioData detaches its input on some engines; hand it
      // a copy so a caller's buffer is never consumed silently.
      buffer = await context.decodeAudioData(bytes.slice(0));
    } catch {
      return null;
    }
    if (!buffer || buffer.length === 0) return null;
    const samples = samplesOfBuffer(buffer);
    // The bridge write: this track, this audio. The fingerprint is
    // taken over the exact samples handed to the supply path, so
    // the hash recorded here is the hash the reads will be stored
    // under. Best-effort — see the header note.
    let audioHash = "";
    try {
      audioHash = audioFingerprint(samples, buffer.sampleRate);
    } catch {
      audioHash = "";
    }
    if (audioHash) {
      // Fire-and-forget, deliberately NOT awaited: the bridge write
      // is bookkeeping, never a precondition of the audio. Awaiting
      // it put preparation at the mercy of the engine DB open, which
      // blocks indefinitely when another window/instance holds an
      // older DB version — in the 0.1.20 field failure that hung
      // open stalled every preparation and the DJ start died
      // silently at its 30 s bound. The behaviour/outcome/shelf
      // adapters already treat their writes this way; a hung or
      // failed bridge write now degrades attribution only.
      try {
        void Promise.resolve(recordAttribution(track.id, audioHash)).catch(
          () => {
            // A bridge failure loses the attribution, never the audio.
          },
        );
      } catch {
        // A bridge failure loses the attribution, never the audio.
      }
    }
    return {
      samples,
      sampleRate: buffer.sampleRate,
      buffer,
      audioHash,
    };
  }

  return { resolveTrackAudio };
}
