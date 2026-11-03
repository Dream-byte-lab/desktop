// Selection (revamp R5): how a choice among scored candidates is
// finally made — blueprint §16's temperature-controlled softmax,
// under §15's anti-repetition doctrine.
//
// Until this slice the brain's pick was deterministic: scoring
// ranked the field, formed the near-equal band, and the band's
// lowest-history-cost member won, ties broken by score then
// enumeration order. Two nights with the same playlist, the same
// history and the same room therefore produced the same joins —
// the formulaic feel the revamp exists to kill. Scoring's pick
// remains exactly what it was (a pinned, auditable reference —
// "the scorer's choice"), but the brain no longer spends it
// directly. It spends THIS module:
//
//   1. Vetoes and feasibility have already spoken (scoring.ts):
//      only the near-equal BAND reaches selection, and the band
//      contains survivors only — a vetoed candidate's probability
//      here is not small, it is exactly zero, because it is not
//      in the input at all.
//   2. Each band member is weighted by §16: exp((s − max) / T).
//   3. Each weight is shaped by §15: multiplied by
//      exp(−sensitivity × recentUses) — the complement of the
//      blueprint's penalty clamp(1 − exp(−sensitivity ×
//      recentUses)). Shaping only, ever: the multiplier is floored
//      above zero, so no finite history can exclude a candidate
//      the evidence blessed. Rigid never-twice rules are
//      forbidden by the same doctrine — they are themselves
//      predictable — and there are none in this module.
//   4. One draw from a seeded generator picks the winner.
//
// One restraint on the lottery, from the field (Note 16): the
// let-it-play family performs NO transition — the outgoing plays
// to its natural end and the incoming starts cold. A full play is
// a legitimate decision (the S5-3 charter keeps it choosable),
// but it is elected by EVIDENCE, never dealt by chance: while the
// band holds any candidate that performs a join, the lottery
// samples among those, and let-it-play is held out. It is
// performed exactly when the old deterministic rule would have
// performed it — when it wins the field outright (no performed
// join within the band of its score) or when history's charges
// have demoted every performed join out of the band (the
// rotation outcome). Early-cut is NOT held out: it performs a
// transition (a cut on a boundary), so it stands in the lottery
// like every other performed family.
//
// The generator's seed derives from session state — the session
// seed, the set's index within the session, and the decision's
// index within the set — so a session's picks are exactly
// reproducible from its coordinates (tests, debugging, the
// ear-test pattern log) while different sessions, different sets
// and different decision points draw different streams. This is
// the blueprint's own stance (§16: a seeded generator kept as
// session state; a fixed seed allowed for debugging).
//
// TEMPERATURE. §16 leaves T to the implementation, floored at
// 0.01. Here T IS the active profile's near-equal band width.
// That is not a pun: the band is the profile's own statement of
// how far below the best a candidate may sit and still count as
// near-equal, so it is the natural scale of "how much score
// difference means how much preference" for that temperament.
// Consequences, all intended:
//   · T(ordered) follows temperament: CONSERVATIVE 0.03 <
//     STANDARD 0.05 < ADVENTUROUS 0.09; the personalities inherit
//     their resolved bands (Radio 0.03, Club/House/Autonomous
//     0.05, Open Format 0.07, Battle 0.09, Experimental 0.11).
//   · The creativity slider bends the band (R4: ×(1 + 1.2d)),
//     so it bends T by the same factor — a more creative room is
//     a flatter lottery, with no second dial to keep in sync.
//   · At the band's edge a candidate's unshaped weight is exactly
//     exp(−1) ≈ 0.37 of the leader's: inside the band the leader
//     is never more than e-to-1 favourite over any member. That
//     ratio is what "near-equal" formally means here.
// The 0.01 floor binds only for synthetic profiles whose band is
// narrower than any shipped temperament's (the narrowest shipped
// value after creativity's deepest downward bend is 0.012).
//
// Everything in this module is pure: no clock, no storage, no
// Math.random. The brain owns the session state (seed, counters)
// and hands each decision its stream.

import type { DecisionProfile, JoinFamily } from "./decisionProfile";
import { evaluationOf, type JoinRecord } from "./joinHistory";
import type { ScoredCandidate } from "./scoring";

// ---------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------

/**
 * xmur3 string hash → uint32. Integer arithmetic only, so a seed
 * hashes identically on every platform and every run.
 */
export function hashSeed(seed: string): number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/**
 * A mulberry32 stream for a seed string: deterministic [0, 1)
 * draws, reproducible from the seed alone.
 */
export function createSeededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed coordinate one decision samples from. */
export function decisionSeed(
  sessionSeed: string,
  setIndex: number,
  decisionIndex: number,
): string {
  return `${sessionSeed}#${setIndex}#${decisionIndex}`;
}

/** The random stream one decision draws from, by its coordinates. */
export function randomForDecision(
  sessionSeed: string,
  setIndex: number,
  decisionIndex: number,
): () => number {
  return createSeededRandom(decisionSeed(sessionSeed, setIndex, decisionIndex));
}

// ---------------------------------------------------------------------
// §16 softmax, §15 shaping — the generic core
// ---------------------------------------------------------------------

/** Blueprint §16's floor: temperature never goes below this. */
export const MIN_TEMPERATURE = 0.01;

/** Temperature, floored per §16 and made finite. */
export function clampTemperature(temperature: number): number {
  if (!Number.isFinite(temperature)) return MIN_TEMPERATURE;
  return Math.max(MIN_TEMPERATURE, temperature);
}

/**
 * Blueprint §15's recent-use penalty, verbatim:
 * clamp(1 − exp(−sensitivity × recentUses)). Zero for a fresh
 * history-facing candidate, rising with each recent use, bounded
 * by 1 — and, as a probability shape (below), never an exclusion.
 */
export function recentUsePenalty(
  recentUses: number,
  sensitivity: number,
): number {
  const uses = Math.max(0, recentUses);
  const s = Math.max(0, sensitivity);
  return Math.min(1, Math.max(0, 1 - Math.exp(-s * uses)));
}

/**
 * The probability multiplier §15's penalty implies: 1 − penalty,
 * computed directly as exp(−sensitivity × recentUses) and floored
 * at 1e-12, so shaping approaches exclusion asymptotically but
 * never reaches it — a candidate the evidence blessed keeps a
 * nonzero chance however often its family was used recently.
 */
export function recentUseMultiplier(
  recentUses: number,
  sensitivity: number,
): number {
  const uses = Math.max(0, recentUses);
  const s = Math.max(0, sensitivity);
  return Math.max(1e-12, Math.exp(-s * uses));
}

/** One entry in a softmax choice. */
export interface SoftmaxEntry {
  /** The entry's score (higher is better; any finite scale). */
  score: number;
  /** How often this entry's move was used recently (§15's input). */
  recentUses?: number;
  /** False = excluded before the lottery: exactly zero probability. */
  eligible?: boolean;
}

export interface SoftmaxOutcome {
  /** Index into the input entries of the sampled winner. */
  index: number;
  /** Probability of every input entry, aligned; 0 for the ineligible. */
  probabilities: number[];
  /** The §15 penalty applied to every input entry, aligned. */
  penalties: number[];
  /** The temperature actually spent (after the §16 floor). */
  temperature: number;
}

/**
 * §16 probabilities over a set of entries: vetoes/exclusions
 * first (eligible === false ⇒ exactly 0), then
 * P ∝ exp((s − max) / T) × §15 multiplier, normalised. Pure.
 */
export function softmaxProbabilities(
  entries: readonly SoftmaxEntry[],
  temperature: number,
  sensitivity: number,
): { probabilities: number[]; penalties: number[]; temperature: number } {
  const t = clampTemperature(temperature);
  const penalties = entries.map((entry) =>
    recentUsePenalty(entry.recentUses ?? 0, sensitivity),
  );
  const eligible = entries.map(
    (entry) => entry.eligible !== false && Number.isFinite(entry.score),
  );
  const max = entries.reduce(
    (best, entry, i) => (eligible[i] ? Math.max(best, entry.score) : best),
    -Infinity,
  );
  if (!Number.isFinite(max)) {
    return {
      probabilities: entries.map(() => 0),
      penalties,
      temperature: t,
    };
  }
  const weights = entries.map((entry, i) =>
    eligible[i]
      ? Math.exp((entry.score - max) / t) *
        recentUseMultiplier(entry.recentUses ?? 0, sensitivity)
      : 0,
  );
  const total = weights.reduce((sum, w) => sum + w, 0);
  return {
    probabilities:
      total > 0
        ? weights.map((w) => w / total)
        : entries.map((_, i) =>
            eligible[i] ? 1 / Math.max(1, eligible.filter(Boolean).length) : 0,
          ),
    penalties,
    temperature: t,
  };
}

/**
 * Sample one entry by its §16/§15 probabilities. Consumes exactly
 * one draw from `random`, so a decision's place in the stream is
 * a pure function of how many decisions preceded it.
 */
export function chooseBySoftmax(
  entries: readonly SoftmaxEntry[],
  options: {
    temperature: number;
    sensitivity?: number;
    random: () => number;
  },
): SoftmaxOutcome {
  const { probabilities, penalties, temperature } = softmaxProbabilities(
    entries,
    options.temperature,
    options.sensitivity ?? 0,
  );
  const draw = options.random();
  let cumulative = 0;
  let index = -1;
  for (let i = 0; i < probabilities.length; i += 1) {
    cumulative += probabilities[i];
    if (draw < cumulative) {
      index = i;
      break;
    }
  }
  if (index === -1) {
    // Float dust at the tail (or an all-zero field): the last
    // entry carrying any probability wins rather than none.
    for (let i = probabilities.length - 1; i >= 0; i -= 1) {
      if (probabilities[i] > 0) {
        index = i;
        break;
      }
    }
  }
  return { index, probabilities, penalties, temperature };
}

// ---------------------------------------------------------------------
// The engine adapter — join candidates under a decision profile
// ---------------------------------------------------------------------

/**
 * The temperature a profile selects at: its near-equal band
 * width, floored at §16's 0.01. See the module header for the
 * defence — temperament ordering and the creativity bend both
 * arrive through the band, because the resolver already spent
 * them there.
 */
export function temperatureForProfile(profile: DecisionProfile): number {
  return clampTemperature(profile.nearEqualBand);
}

/**
 * §15's sensitivity under a profile: the same constant that
 * prices a family repeat in the score (antiRepetition's
 * familyRepeatCost), spent here in probability currency. One
 * anti-repetition intensity per temperament, two expressions —
 * the score charge decides whether a repeat stays in the band;
 * this shaping decides how the lottery leans among the band the
 * evidence already blessed.
 */
export function recentUseSensitivity(profile: DecisionProfile): number {
  return profile.antiRepetition.familyRepeatCost;
}

/**
 * How many of the profile's recent-join window used this family —
 * §15's `recentUses`, read from the join-history store's records
 * (the same window repetitionCost reads; a raw count, where the
 * score's charge additionally decays by rank).
 */
export function countRecentFamilyUses(
  history: readonly JoinRecord[],
  family: JoinFamily,
  windowJoins: number,
): number {
  const window = windowJoins > 0 ? history.slice(-windowJoins) : [];
  return window.reduce(
    (n, record) => (record.family === family ? n + 1 : n),
    0,
  );
}

/**
 * §28's feedback, spent in §15's currency (revamp R6). A past join
 * of this family counts toward `recentUses` by how WELL it went:
 *
 *   weight = 1 + (0.5 − evaluation.overall), bounded to [0.5, 1.5]
 *
 * A join that scored perfectly counts half (success earns relief
 * from the repetition charge — the move proved itself); a join
 * that scored zero counts one and a half (the room is steered
 * away from repeating a move that went badly); a middling join
 * counts exactly one. Records carrying no evaluation — everything
 * written before R6, and any caller that supplied no outcome —
 * count exactly one, so this weighting is invisible until §28
 * evaluations exist: parity by construction. Shaping only, per
 * the doctrine: the weight is bounded on both sides, so an
 * evaluation can lean the lottery but can never exclude a family
 * or guarantee one.
 */
export function evaluationUseWeight(record: JoinRecord): number {
  const evaluation = evaluationOf(record);
  if (!evaluation) return 1;
  return Math.min(1.5, Math.max(0.5, 1 + (0.5 - evaluation.overall)));
}

/** countRecentFamilyUses, with each use weighed by its §28 outcome. */
export function countRecentFamilyUsesWeighted(
  history: readonly JoinRecord[],
  family: JoinFamily,
  windowJoins: number,
): number {
  const window = windowJoins > 0 ? history.slice(-windowJoins) : [];
  return window.reduce(
    (n, record) =>
      record.family === family ? n + evaluationUseWeight(record) : n,
    0,
  );
}

/** The auditable record of one selection, carried on the decision. */
export interface SelectionRecord {
  /**
   * How the performed candidate was chosen: "softmax" — sampled
   * from the near-equal band by the §16 lottery (the brain's own
   * decisions); "manual" — the host's deliberate trigger on the
   * stage (the DJ stage engine seams): no draw was made, the band
   * holds the single authored candidate at probability 1, and the
   * seed names the standing lottery coordinate WITHOUT consuming
   * it, so a manual act never shifts the stream the brain's next
   * own decision draws from.
   */
  method: "softmax" | "manual";
  /** The full seed coordinate the decision sampled from. */
  seed: string;
  /** Temperature spent (the profile's band, floored). */
  temperature: number;
  /** §15 sensitivity spent. */
  sensitivity: number;
  /** The band as the lottery saw it, in band order. */
  band: {
    family: JoinFamily;
    score: number;
    historyCost: number;
    recentUses: number;
    penalty: number;
    probability: number;
  }[];
  /**
   * Band members held out of the lottery by the evidence-election
   * rule (the no-transition family, while a performed join stood
   * in the band): their scores, so the trail shows what chance
   * was not allowed to deal.
   */
  restraintHeld: { family: JoinFamily; score: number }[];
  /** Index into `band` of the sampled winner. */
  chosenIndex: number;
  /** Whether the sample agreed with scoring's deterministic pick. */
  agreedWithScorer: boolean;
}

export interface BandSelection {
  chosen: ScoredCandidate;
  record: SelectionRecord;
}

/**
 * The family that performs no transition. While the band holds a
 * performed join, this family is evidence-elected only (see the
 * module header) and stands outside the lottery.
 */
export const NO_TRANSITION_FAMILY: JoinFamily = "let-it-play";

/**
 * Spend the lottery over scoring's near-equal band. The band is
 * the input — survivors only, so vetoed candidates are not in
 * the record at all: their probability was zero by construction
 * before this function ran. The no-transition family is held
 * out while any performed join stands in the band. Always
 * consumes exactly one draw.
 */
export function selectFromBand(
  band: readonly ScoredCandidate[],
  options: {
    profile: DecisionProfile;
    history: readonly JoinRecord[];
    random: () => number;
    seed: string;
    scorerPick: ScoredCandidate | null;
  },
): BandSelection {
  const { profile, history } = options;
  const temperature = temperatureForProfile(profile);
  const sensitivity = recentUseSensitivity(profile);
  const performed = band.filter(
    (scored) => scored.candidate.family !== NO_TRANSITION_FAMILY,
  );
  const restraintHeld =
    performed.length > 0
      ? band
          .filter((scored) => scored.candidate.family === NO_TRANSITION_FAMILY)
          .map((scored) => ({
            family: scored.candidate.family,
            score: scored.score,
          }))
      : [];
  const pool = performed.length > 0 ? performed : band;
  const entries: SoftmaxEntry[] = pool.map((scored) => ({
    score: scored.score,
    // §15's input, §28-weighed (R6): a family whose recent joins
    // went badly counts more heavily here than one whose joins
    // landed — see countRecentFamilyUsesWeighted. Evaluation-free
    // histories count exactly as the raw count always did.
    recentUses: countRecentFamilyUsesWeighted(
      history,
      scored.candidate.family,
      profile.antiRepetition.windowJoins,
    ),
  }));
  const outcome = chooseBySoftmax(entries, {
    temperature,
    sensitivity,
    random: options.random,
  });
  const chosenIndex = Math.max(0, outcome.index);
  const chosen = pool[chosenIndex] ?? pool[0];
  return {
    chosen,
    record: {
      method: "softmax",
      seed: options.seed,
      temperature: outcome.temperature,
      sensitivity,
      band: pool.map((scored, i) => ({
        family: scored.candidate.family,
        score: scored.score,
        historyCost: scored.historyCost,
        recentUses: entries[i].recentUses ?? 0,
        penalty: outcome.penalties[i],
        probability: outcome.probabilities[i],
      })),
      restraintHeld,
      chosenIndex,
      agreedWithScorer:
        options.scorerPick !== null && chosen === options.scorerPick,
    },
  };
}

// ---------------------------------------------------------------------
// The R6 entry point — track choice (exposed, not yet wired)
// ---------------------------------------------------------------------

/** One scored track candidate, in the caller's own item type. */
export interface TrackChoiceEntry<T> {
  item: T;
  /** The caller's score for this candidate (higher is better). */
  score: number;
  /** Recent uses of this candidate's move, for §15 (optional). */
  recentUses?: number;
  /** The standing order's holder — holds the incumbency head start. */
  incumbent?: boolean;
}

export interface TrackSelection<T> {
  entry: TrackChoiceEntry<T>;
  /** Index into the input entries. */
  index: number;
  /** Probability of every input entry, aligned; 0 outside the band. */
  probabilities: number[];
  /** How many entries the epsilon admitted to the band. */
  bandSize: number;
  temperature: number;
}

/**
 * The selection R6 will spend at the per-join track choice, in
 * R4's curation currency: the band is the entries within
 * `epsilon` (the resolver's nearEqualEpsilon) of the best score;
 * the incumbent's logit carries `incumbencyPenalty` (the
 * resolver's value) as a head start its rivals' scores must
 * overcome; §15 shaping and the §16 temperature then apply
 * exactly as they do for joins. Entries outside the band have
 * exactly zero probability. Returns null for an empty field.
 *
 * NOT wired anywhere in R5: the session still walks the queue in
 * order; playlist-bounded autonomy (R6) is where this becomes
 * the per-join track pick.
 */
export function selectTrackCandidate<T>(
  entries: readonly TrackChoiceEntry<T>[],
  options: {
    epsilon: number;
    incumbencyPenalty: number;
    temperature: number;
    sensitivity?: number;
    random: () => number;
  },
): TrackSelection<T> | null {
  if (entries.length === 0) return null;
  const best = entries.reduce(
    (max, entry) => Math.max(max, entry.score),
    -Infinity,
  );
  if (!Number.isFinite(best)) return null;
  const inBand = entries.map(
    (entry) => best - entry.score <= Math.max(0, options.epsilon),
  );
  const softmaxEntries: SoftmaxEntry[] = entries.map((entry, i) => ({
    score: entry.score + (entry.incumbent ? options.incumbencyPenalty : 0),
    recentUses: entry.recentUses,
    eligible: inBand[i],
  }));
  const outcome = chooseBySoftmax(softmaxEntries, {
    temperature: options.temperature,
    sensitivity: options.sensitivity ?? 0,
    random: options.random,
  });
  if (outcome.index < 0) return null;
  return {
    entry: entries[outcome.index],
    index: outcome.index,
    probabilities: outcome.probabilities,
    bandSize: inBand.filter(Boolean).length,
    temperature: outcome.temperature,
  };
}
