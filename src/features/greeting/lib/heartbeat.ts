// The greeting visualizer's pulse: a slow heartbeat.
//
// The user asked for the visualizer to move like a heartbeat — a
// gentle lub-dub swell, slow and calm — never frantic bars dancing.
// This module is that pulse as pure, testable mathematics:
//
// - The SHAPE is a heartbeat envelope: two thumps per cycle (the
//   second softer, like a real dub), easing back between them,
//   never falling fully silent.
// - At REST the pulse runs at a resting rate and a small amplitude:
//   present as ambience, unmistakably not a performance.
// - With real audio, the pulse is SHAPED by the music: bass energy
//   deepens the swell, and a sharp bass rise starts a thump on the
//   music's own pulse, so the heart beats with the song. When the
//   energy goes away the amplitude eases back to the resting beat
//   — it decays home, it does not snap off.
// - On appearance the whole field fades in over FADE_IN_SEC: no
//   pop, no sudden full-amplitude start.
//
// All tunables live in HEARTBEAT below — one place to adjust the
// character. The state machine is a closure advanced by the
// renderer's rAF clock; it owns no timers and no DOM.

export const HEARTBEAT = {
  /** Resting rate, beats per minute — the idle pulse's tempo. */
  IDLE_BPM: 55,
  /** Where the first thump (lub) peaks in the cycle, 0..1. */
  LUB_PHASE: 0.1,
  /** Where the second thump (dub) peaks in the cycle, 0..1. */
  DUB_PHASE: 0.37,
  /** The dub's strength relative to the lub. */
  DUB_STRENGTH: 0.62,
  /** Each thump's width, as a fraction of the cycle. */
  THUMP_WIDTH: 0.17,
  /** Envelope floor between thumps — the swell never fully dies. */
  BASELINE: 0.18,
  /**
   * The idle beat's amplitude ceiling: at rest the swell may only
   * ever move this much of the field. Small, slow, regular — a
   * resting state, never a performance.
   */
  IDLE_AMPLITUDE: 0.14,
  /** Smoothed bass rise (0..1) that counts as a musical pulse. */
  ONSET_RISE: 0.14,
  /** Seconds after a thump before another onset may retrigger. */
  REFRACTORY_SEC: 0.45,
  /** How fast the swell builds toward a louder target, seconds. */
  SWELL_TAU_SEC: 0.25,
  /** How slowly amplitude eases back toward rest, seconds. */
  DECAY_TAU_SEC: 1.4,
  /** Mount fade-in, seconds — the appearance is a swell, not a pop. */
  FADE_IN_SEC: 1.1,
  /** The field's floor: even at envelope baseline, this much shows. */
  FIELD_FLOOR: 0.12,
} as const;

/** One thump's contribution at a phase distance from its centre. */
function thump(distance: number): number {
  const d = Math.abs(distance);
  if (d >= HEARTBEAT.THUMP_WIDTH) return 0;
  // Raised cosine: smooth in, smooth out, no corners.
  const raised = 0.5 + 0.5 * Math.cos((Math.PI * d) / HEARTBEAT.THUMP_WIDTH);
  return raised;
}

/**
 * The heartbeat envelope at a point in its cycle (phase 0..1):
 * a lub, a softer dub, and an easing floor between them.
 * Returns BASELINE..1.
 */
export function heartbeatEnvelope(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  const lub = thump(p - HEARTBEAT.LUB_PHASE);
  const dub = thump(p - HEARTBEAT.DUB_PHASE) * HEARTBEAT.DUB_STRENGTH;
  const peak = Math.min(1, lub + dub);
  return HEARTBEAT.BASELINE + (1 - HEARTBEAT.BASELINE) * peak;
}

/** The cycle length in seconds at the resting rate. */
export function heartbeatPeriodSec(): number {
  return 60 / HEARTBEAT.IDLE_BPM;
}

export interface Heartbeat {
  /**
   * Advance the pulse by dtSec. `bassEnergy` is the music's
   * smoothed low-band energy (0..1) when real audio is sounding,
   * or null when nothing is live. Returns the field scale (0..1)
   * to render at: the envelope, amplitude-shaped, mount-faded.
   */
  update: (dtSec: number, bassEnergy: number | null) => number;
}

export function createHeartbeat(): Heartbeat {
  const period = heartbeatPeriodSec();
  let phase = 0;
  let elapsed = 0;
  let sinceThump = Number.POSITIVE_INFINITY;
  let amplitude: number = HEARTBEAT.IDLE_AMPLITUDE;
  let prevBass: number | null = null;

  const approach = (target: number, tau: number, dt: number): number => {
    const k = 1 - Math.exp(-dt / tau);
    return amplitude + (target - amplitude) * k;
  };

  return {
    update(dtSec, bassEnergy) {
      const dt = Math.max(0, Math.min(dtSec, 0.1));
      elapsed += dt;
      sinceThump += dt;
      phase = (phase + dt / period) % 1;

      if (bassEnergy !== null) {
        // A sharp bass rise is the song's own pulse: start a thump
        // on it (rate-limited by the refractory window), and let the
        // energy deepen the swell toward its loudness.
        const rise = prevBass === null ? 0 : bassEnergy - prevBass;
        if (
          rise > HEARTBEAT.ONSET_RISE &&
          sinceThump > HEARTBEAT.REFRACTORY_SEC
        ) {
          phase = 0;
          sinceThump = 0;
          amplitude = Math.max(
            amplitude,
            HEARTBEAT.IDLE_AMPLITUDE +
              bassEnergy * (1 - HEARTBEAT.IDLE_AMPLITUDE) * 0.85,
          );
        }
        const target =
          HEARTBEAT.IDLE_AMPLITUDE +
          bassEnergy * (1 - HEARTBEAT.IDLE_AMPLITUDE);
        amplitude = approach(
          target,
          target > amplitude
            ? HEARTBEAT.SWELL_TAU_SEC
            : HEARTBEAT.DECAY_TAU_SEC,
          dt,
        );
        prevBass = bassEnergy;
      } else {
        // No live audio: ease home to the resting beat.
        amplitude = approach(
          HEARTBEAT.IDLE_AMPLITUDE,
          HEARTBEAT.DECAY_TAU_SEC,
          dt,
        );
        prevBass = null;
      }

      const fade = Math.min(1, elapsed / HEARTBEAT.FADE_IN_SEC);
      const fadeEased = fade * fade * (3 - 2 * fade);
      const swell =
        HEARTBEAT.FIELD_FLOOR +
        (1 - HEARTBEAT.FIELD_FLOOR) * heartbeatEnvelope(phase) * amplitude;
      return swell * fadeEased;
    },
  };
}
