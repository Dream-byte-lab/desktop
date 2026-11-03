import { HEARTBEAT, heartbeatEnvelope } from "./heartbeat";

// The greeting visualizer's drawn form: flowing wavelines
// (standing Ruling 4, 2026-11-03 — the blurred background carries
// flowing wavelines, not bars). This module is the lines as pure,
// testable mathematics; the component only strokes what it says.
//
// The model: a small set of layered lines runs the full width of
// the card, edge to edge. Each line's height at a point is its
// baseline minus a displacement with two parts, both shaped by
// the SAME inputs the retired bars used:
//
// - the sampled profile (the tap registry's 36-point field — real
//   frequency data when live, the still rest ridge when not),
//   smoothed by the component exactly as before; and
// - a travelling ripple, a sine whose phase advances with time,
//   so the lines FLOW horizontally through the anchored profile
//   instead of merely bobbing in place. Layers are phase-offset
//   and run at different speeds and depths, back to front, for
//   the feel of depth in moving water.
//
// Everything is scaled by the heartbeat's swell (lib/heartbeat):
// at rest the swell is the idle pulse, so the lines breathe
// gently at 55 BPM under their small amplitude ceiling; with
// real audio the bass deepens the swell and the same lines swing
// wider and flow faster. Nothing here invents motion of its own
// — freeze the swell and the phases, and the field is still.

/** Profile points across the width — the registry sample's width. */
export const WAVELINE_POINTS = 36;

/**
 * The most a line may ever rise above its baseline, as a
 * fraction of the canvas height, before its layer gain applies.
 */
export const WAVELINE_MAX_DISPLACEMENT = 0.5;

export interface WavelineLayer {
  /** Displacement multiplier for this layer (back layers swing less). */
  gain: number;
  /** The line's resting height, as a fraction of canvas height. */
  baseline: number;
  /** Ripple sine cycles across the card's width. */
  rippleCycles: number;
  /** The ripple's share of the displacement (the rest is profile). */
  rippleDepth: number;
  /** Phase advance, radians per second at flow scale 1. */
  phaseSpeed: number;
  /** Where this layer's ripple starts — the layers never align. */
  phaseStart: number;
  /** Stroke alpha for the layer's main pass. */
  alpha: number;
  /** Stroke width of the main pass, in CSS pixels. */
  lineWidth: number;
}

/**
 * The layers, back to front: each nearer line sits lower, swings
 * wider, flows faster and reads stronger than the one behind it.
 */
export const WAVELINE_LAYERS: readonly WavelineLayer[] = [
  {
    gain: 0.5,
    baseline: 0.64,
    rippleCycles: 1.4,
    rippleDepth: 0.35,
    phaseSpeed: 0.8,
    phaseStart: 4.2,
    alpha: 0.3,
    lineWidth: 1.1,
  },
  {
    gain: 0.75,
    baseline: 0.7,
    rippleCycles: 1.8,
    rippleDepth: 0.42,
    phaseSpeed: 1.2,
    phaseStart: 2.1,
    alpha: 0.42,
    lineWidth: 1.4,
  },
  {
    gain: 1,
    baseline: 0.76,
    rippleCycles: 2.3,
    rippleDepth: 0.5,
    phaseSpeed: 1.7,
    phaseStart: 0,
    alpha: 0.55,
    lineWidth: 1.8,
  },
];

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * One layer's points for a frame: the y of each profile point as
 * a fraction of canvas height (0 = top). The profile anchors the
 * shape (low frequencies stay left, as the data says); the
 * ripple, phase-advanced, is what makes it flow. The ripple is
 * weighted by the profile (0.35 + 0.65·p), so quiet stretches of
 * the field ripple gently and loud stretches swing — the line
 * never thrashes where the music is calm.
 */
export function wavelinePointFractions(
  layerIndex: number,
  profile: ArrayLike<number>,
  swell: number,
  phase: number,
  out: Float32Array,
): void {
  const layer = WAVELINE_LAYERS[layerIndex];
  const count = profile.length;
  const scale = WAVELINE_MAX_DISPLACEMENT * layer.gain * clamp01(swell);
  for (let i = 0; i < count; i += 1) {
    const u = count <= 1 ? 0 : i / (count - 1);
    const p = clamp01(profile[i] ?? 0);
    const ripple = Math.sin(2 * Math.PI * layer.rippleCycles * u + phase);
    const shape =
      p * (1 - layer.rippleDepth) +
      layer.rippleDepth * ripple * (0.35 + 0.65 * p);
    out[i] = layer.baseline - scale * shape;
  }
}

/**
 * The swell for the reduced-motion still: the resting pulse at
 * its lub peak — the heartbeat's own idle ceiling, derived from
 * HEARTBEAT rather than re-tuned here. A still drawn at this
 * swell is the idle field caught mid-breath.
 */
export function wavelineRestingSwell(): number {
  return (
    HEARTBEAT.FIELD_FLOOR +
    (1 - HEARTBEAT.FIELD_FLOOR) *
      heartbeatEnvelope(HEARTBEAT.LUB_PHASE) *
      HEARTBEAT.IDLE_AMPLITUDE
  );
}

export interface WavelineFlow {
  /**
   * Advance every layer's ripple phase by dtSec and return the
   * phases. The flow quickens as the swell deepens (music pushes
   * the current); at the idle swell it drifts at a little over
   * half speed — present, never busy.
   */
  update: (dtSec: number, swell: number) => readonly number[];
}

export function createWavelineFlow(): WavelineFlow {
  const phases = WAVELINE_LAYERS.map((layer) => layer.phaseStart);
  return {
    update(dtSec, swell) {
      // Mirrored clamp from the heartbeat: a stalled frame must
      // not teleport the ripple when the loop resumes.
      const dt = Math.max(0, Math.min(dtSec, 0.1));
      const flowScale = 0.55 + 0.75 * clamp01(swell);
      for (let i = 0; i < phases.length; i += 1) {
        phases[i] += dt * WAVELINE_LAYERS[i].phaseSpeed * flowScale;
      }
      return phases;
    },
  };
}
