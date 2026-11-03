// Minimal ambient declarations for the "soundtouchjs" package
// (LGPL-2.1, already a production dependency of this app — see
// package.json — but it ships no TypeScript types of its own).
//
// SPIKE-ADJACENT (Step 5, slice S5-5): these declarations exist so the
// time-stretch spike (timeStretch.ts) can drive the library's offline
// pipeline with types. Only the surface the spike uses is declared:
// the SoundTouch pipe, its Stretch stage's parameter setter, and the
// SimpleFilter pull-pipeline. If the spike's verdict is NO-GO and
// timeStretch.ts is removed, this file goes with it.

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
    /**
     * sampleRate in Hz; sequenceMs / seekWindowMs of 0 keep the
     * library's tempo-adaptive automatic lengths; overlapMs is the
     * crossfade overlap (library default 8).
     */
    setParameters(
      sampleRate: number,
      sequenceMs: number,
      seekWindowMs: number,
      overlapMs: number,
    ): void;
    /** True trades overlap-search quality for speed. Default true in
     * the JS port (the C++ library defaults to the quality search). */
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
}
