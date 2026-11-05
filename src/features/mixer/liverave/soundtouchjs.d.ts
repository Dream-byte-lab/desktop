// Minimal ambient declarations for the "soundtouchjs" package
// (LGPL-2.1, a production dependency — see package.json — which
// ships no TypeScript types of its own).
//
// This declaration lives WITH the fresh performer because the purge
// deletes the older copy under src/features/mixer/engine/; the
// performer must not depend on anything in that tree. Only the
// offline pull-pipeline surface the rendition provider uses is
// declared: SoundTouch (tempo stage), SimpleFilter (pull pipeline)
// and WebAudioBufferSource (an AudioBuffer-backed frame source).

declare module "soundtouchjs" {
  /** Anything SimpleFilter can pull interleaved stereo frames from. */
  export interface SoundTouchSource {
    extract(
      target: Float32Array,
      numFrames?: number,
      position?: number,
    ): number;
  }

  /** The time-domain stretch stage of the SoundTouch pipe. */
  export class Stretch {
    setParameters(
      sampleRate: number,
      sequenceMs: number,
      seekWindowMs: number,
      overlapMs: number,
    ): void;
    quickSeek: boolean;
  }

  /** The SoundTouch processing pipe (rate transposer + stretch). */
  export class SoundTouch {
    /** Tempo multiplier: 1.09 = 9% faster (shorter), pitch held. */
    tempo: number;
    /** Rate multiplier (resampling — pitch moves with tempo). */
    rate: number;
    /** Pitch multiplier at constant tempo. */
    pitch: number;
    readonly stretch: Stretch;
    clear(): void;
  }

  /** Pull pipeline: feed it a source and a pipe, extract until 0. */
  export class SimpleFilter {
    constructor(
      source: SoundTouchSource,
      pipe: SoundTouch,
      callback?: () => void,
    );
    extract(target: Float32Array, numFrames?: number): number;
    readonly sourcePosition: number;
  }

  /** A SoundTouchSource backed by a Web Audio AudioBuffer. */
  export class WebAudioBufferSource implements SoundTouchSource {
    constructor(buffer: AudioBuffer);
    extract(
      target: Float32Array,
      numFrames?: number,
      position?: number,
    ): number;
  }
}
