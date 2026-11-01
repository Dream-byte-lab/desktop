import type { KeyEstimate } from "./detectKey";

// How well two keys sit together in a blend — the harmonic half of the
// referee's judgement. The scores follow standard Camelot-wheel
// practice:
//
// - the same key is a perfect match;
// - relative major/minor (same Camelot number, other letter: C major
//   and A minor share their notes) is nearly as safe;
// - one step around the wheel in the same mode (a fifth up or down)
//   is the classic energy-lifting move;
// - one step AND the other letter ("diagonal") works, less smoothly;
// - the parallel key (same tonic, other mode: C major → C minor) is
//   a deliberate mood flip some DJs use on purpose — middling score;
// - two steps away in the same mode still passes at a distance;
// - anything further is a clash for blending purposes (a cut or an
//   echo-out can still join such tracks honestly — just not a blend).

export type KeyRelation =
  | "same"
  | "relative"
  | "adjacent"
  | "diagonal"
  | "parallel"
  | "near"
  | "distant";

export interface KeyCompatibility {
  /** 0..1 — 1 is a perfect harmonic match. */
  score: number;
  relation: KeyRelation;
  /** True when a blend is harmonically safe (score at least 0.6). */
  compatible: boolean;
}

export const KEY_COMPATIBLE_THRESHOLD = 0.6;

function camelotParts(key: KeyEstimate): { number: number; letter: string } {
  const match = /^(\d{1,2})([AB])$/.exec(key.camelot);
  if (!match) return { number: 0, letter: "" };
  return { number: parseInt(match[1], 10), letter: match[2] };
}

function wheelDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 12;
  return Math.min(diff, 12 - diff);
}

export function keyCompatibility(
  outgoing: KeyEstimate | null,
  incoming: KeyEstimate | null,
): KeyCompatibility | null {
  if (!outgoing || !incoming) return null;

  if (
    outgoing.pitchClass === incoming.pitchClass &&
    outgoing.mode === incoming.mode
  ) {
    return { score: 1, relation: "same", compatible: true };
  }
  // Same tonic, other mode.
  if (outgoing.pitchClass === incoming.pitchClass) {
    return { score: 0.5, relation: "parallel", compatible: false };
  }

  const a = camelotParts(outgoing);
  const b = camelotParts(incoming);
  const distance = wheelDistance(a.number, b.number);
  const sameLetter = a.letter === b.letter;

  if (distance === 0) {
    // Same number, other letter and not the same tonic: the relative.
    return { score: 0.9, relation: "relative", compatible: true };
  }
  if (distance === 1 && sameLetter) {
    return { score: 0.85, relation: "adjacent", compatible: true };
  }
  if (distance === 1) {
    return { score: 0.6, relation: "diagonal", compatible: true };
  }
  if (distance === 2 && sameLetter) {
    return { score: 0.35, relation: "near", compatible: false };
  }
  return { score: 0.1, relation: "distant", compatible: false };
}
