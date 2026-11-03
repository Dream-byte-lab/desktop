// The greeting composer. The old greeting picked from five fixed
// sentences; this assembles each greeting at the moment of showing
// from parts — opener x name-weaving x middle x closer x structure —
// multiplied by live context (weekday, season, streak, return gap,
// first-open-of-day). Parts multiply, so the space is tens of
// thousands of wordings per band before context, and context makes
// whole families of it unreachable on the wrong day. Over it all,
// the no-repeat memory (greetingMemory.ts) redraws any repeat.
//
// Pure and deterministic given its inputs: randomness is injected
// as `rng`, and the draw order is fixed — (1) structure, (2) opener,
// (3) weaving, (4) middle, (5) closer — so tests can rig sequences.

import {
  greetingBandIdAt,
  type Greeting,
  type GreetingBandId,
} from "./greeting";
import type { GreetingMemoryState, SessionContext } from "./greetingMemory";
import {
  AGAIN_LINES,
  BAND_PARTS,
  FIRST_EVER_LINES,
  LONG_RETURN_LINES,
  RETURN_LINES,
  SEASON_LINES,
  SHARED_CLOSERS,
  STREAK_LINES,
  WEEKDAY_LINES,
  type Opener,
} from "./parts";

export type { Greeting };
export type { SessionContext };

/** Structure bands for the first rng draw. */
const STRUCTURE_CLASSIC_UNDER = 0.45;
const STRUCTURE_PLUS_UNDER = 0.7;
const STRUCTURE_OBSERVED_UNDER = 0.85;

type Structure = "classic" | "classicPlus" | "observed" | "short";

/** Hours away after which a first-open-of-day counts as a return. */
const RETURN_GAP_HOURS = 30;
const LONG_RETURN_GAP_HOURS = 24 * 7;
/** Streak length at which the streak itself becomes greeting material. */
const STREAK_HEADLINE_MIN = 3;

export interface ComposeInput {
  date: Date;
  name?: string;
  context: SessionContext;
  rng: () => number;
}

function pickIndex(rng: () => number, count: number): number {
  return Math.min(count - 1, Math.floor(rng() * count));
}

function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text)
    ? text.charAt(0).toLowerCase() + text.slice(1)
    : text;
}

function seasonOf(date: Date): string {
  const month = date.getMonth();
  if (month >= 2 && month <= 4) return "spring";
  if (month >= 5 && month <= 7) return "summer";
  if (month >= 8 && month <= 10) return "autumn";
  return "winter";
}

/** Context material for an opening: headline observations + extra middles. */
export function contextLinesFor(
  context: SessionContext,
  date: Date,
): { observations: string[]; extraMiddles: string[] } {
  const observations: string[] = [];
  if (context.isFirstEver) {
    observations.push(...FIRST_EVER_LINES);
  } else if (context.isFirstOpenToday) {
    const gap = context.hoursSinceLastSession ?? 0;
    if (gap >= LONG_RETURN_GAP_HOURS) observations.push(...LONG_RETURN_LINES);
    else if (gap >= RETURN_GAP_HOURS) observations.push(...RETURN_LINES);
    if (context.streakDays >= STREAK_HEADLINE_MIN) {
      observations.push(
        ...STREAK_LINES.map((line) =>
          line.replace("{streak}", `${context.streakDays}`),
        ),
      );
    }
  }
  if (!context.isFirstOpenToday && !context.isFirstEver) {
    observations.push(...AGAIN_LINES);
  }
  const extraMiddles: string[] = [
    ...(WEEKDAY_LINES[date.getDay()] ?? []),
    ...(SEASON_LINES[seasonOf(date)] ?? []),
  ];
  return { observations, extraMiddles };
}

// Weavings: how the name joins the opener. Indices are stable —
// eligibility below refers to them.
const WEAVE_SUFFIX = 0;
const WEAVE_PREFIX = 1;
const WEAVE_HEY = 2;
const WEAVE_TO_YOU = 3;
const WEAVE_NONE = 4;

function eligibleWeaves(opener: Opener, named: boolean): number[] {
  if (!named) return [WEAVE_NONE];
  if (opener.salutation && !opener.question)
    return [WEAVE_SUFFIX, WEAVE_PREFIX, WEAVE_HEY, WEAVE_TO_YOU];
  return [WEAVE_SUFFIX, WEAVE_PREFIX, WEAVE_HEY];
}

function weave(opener: Opener, weaveIndex: number, name?: string): string {
  const lower = lowerFirst(opener.text);
  switch (weaveIndex) {
    case WEAVE_SUFFIX:
      return opener.question
        ? `${opener.text.slice(0, -1)}, ${name}?`
        : `${opener.text}, ${name}`;
    case WEAVE_PREFIX:
      return `${name}, ${lower}`;
    case WEAVE_HEY:
      return `Hey ${name} — ${lower}`;
    case WEAVE_TO_YOU:
      return `${opener.text} to you, ${name}`;
    default:
      return opener.text;
  }
}

interface Slots {
  structure: Structure;
  openerIndex: number;
  weaveIndex: number;
  middleIndex: number;
  closerIndex: number;
  observationIndex: number;
}

function assemble(
  band: GreetingBandId,
  context: SessionContext,
  date: Date,
  name: string | undefined,
  slots: Slots,
): Greeting {
  const parts = BAND_PARTS[band];
  const { observations, extraMiddles } = contextLinesFor(context, date);
  const middles = [...parts.middles, ...extraMiddles];
  const closers = [...parts.closers, ...SHARED_CLOSERS];
  const opener = parts.openers[slots.openerIndex];
  const headline = weave(opener, slots.weaveIndex, name);
  const middle = middles[slots.middleIndex % middles.length];
  const closer = closers[slots.closerIndex % closers.length];
  switch (slots.structure) {
    case "observed": {
      const observation =
        observations[slots.observationIndex % observations.length];
      return {
        headline: name ? `${observation}, ${name}.` : `${observation}.`,
        subline: middle,
      };
    }
    case "classicPlus":
      return { headline, subline: `${middle} ${closer}` };
    case "short":
      return { headline, subline: closer };
    default:
      return { headline, subline: middle };
  }
}

/** Assembles one greeting from the parts, per the fixed draw order. */
export function composeGreeting(input: ComposeInput): Greeting {
  const { date, name, context, rng } = input;
  const band = greetingBandIdAt(date);
  const parts = BAND_PARTS[band];
  const { observations, extraMiddles } = contextLinesFor(context, date);

  const structureRoll = rng();
  let structure: Structure = "classic";
  if (structureRoll >= STRUCTURE_OBSERVED_UNDER) structure = "short";
  else if (structureRoll >= STRUCTURE_PLUS_UNDER)
    structure = observations.length > 0 ? "observed" : "classic";
  else if (structureRoll >= STRUCTURE_CLASSIC_UNDER) structure = "classicPlus";

  const openerIndex = pickIndex(rng, parts.openers.length);
  const opener = parts.openers[openerIndex];
  const weaves = eligibleWeaves(opener, Boolean(name));
  const weaveIndex = weaves[pickIndex(rng, weaves.length)];
  const middleIndex = pickIndex(
    rng,
    parts.middles.length + extraMiddles.length,
  );
  const closerIndex = pickIndex(
    rng,
    parts.closers.length + SHARED_CLOSERS.length,
  );
  const observationIndex =
    observations.length > 0 ? pickIndex(rng, observations.length) : 0;

  return assemble(band, context, date, name, {
    structure,
    openerIndex,
    weaveIndex,
    middleIndex,
    closerIndex,
    observationIndex,
  });
}

/** A short stable hash of a greeting's exact words (FNV-1a, hex). */
export function greetingHash(greeting: Greeting): string {
  const text = `${greeting.headline}\n${greeting.subline}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

const MAX_REDRAWS = 24;

/**
 * Composes a greeting that is NOT in the memory's shown set. A drawn
 * repeat is discarded and redrawn; after MAX_REDRAWS collisions
 * (for practical purposes impossible — the per-band space dwarfs the
 * 500-entry memory) a deterministic sweep over middles x closers
 * finds an unseen combination directly.
 */
export function composeFreshGreeting(
  input: ComposeInput,
  memory: GreetingMemoryState,
): { greeting: Greeting; hash: string } {
  const shown = new Set(memory.shownHashes);
  for (let attempt = 0; attempt < MAX_REDRAWS; attempt++) {
    const greeting = composeGreeting(input);
    const hash = greetingHash(greeting);
    if (!shown.has(hash)) return { greeting, hash };
  }
  const band = greetingBandIdAt(input.date);
  const parts = BAND_PARTS[band];
  const weaves = eligibleWeaves(parts.openers[0], Boolean(input.name));
  for (let middleIndex = 0; middleIndex < parts.middles.length; middleIndex++) {
    for (
      let closerIndex = 0;
      closerIndex < parts.closers.length + SHARED_CLOSERS.length;
      closerIndex++
    ) {
      const greeting = assemble(band, input.context, input.date, input.name, {
        structure: "classicPlus",
        openerIndex: 0,
        weaveIndex: weaves[0],
        middleIndex,
        closerIndex,
        observationIndex: 0,
      });
      const hash = greetingHash(greeting);
      if (!shown.has(hash)) return { greeting, hash };
    }
  }
  // Unreachable while the parts tables hold more combinations than
  // the memory can remember; returned only if tables ever shrink.
  const greeting = composeGreeting(input);
  return { greeting, hash: greetingHash(greeting) };
}
