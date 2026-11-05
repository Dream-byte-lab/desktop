// distribution.ts — the Wave 5 distribution runner (design §5).
//
// Measures the AUTONOMOUS engine's actual behaviour: for each
// configuration (autonomous + the six personalities, all at neutral
// sliders) a seeded brain is run over the fixture library's pairs —
// along the 5 playlist arcs (consecutive pairs, at their arc
// positions) and across the full ordered-pair matrix the arcs do
// not cover — and every DRAWN recipe is tallied. The draw is the
// behaviour: no memory is injected (memory only damps; the shaped
// evidence draw is what the personalities actually change), and no
// manual path is exercised anywhere in this module.
//
// The brain has NO fallback / plain-cut concept: consider() returns
// either a drawn JoinRecipe or null (no candidate at/above the pool
// floor for that pair). Nulls are tallied as their own outcome —
// what the session does with a null or an unprepared draw is the
// session simulation's evidence (distribution.test.ts), never a
// silent substitution here.
//
// Scoring (scoreBrainTargets) quotes design §5 targets T1–T4 with
// actual counts; a miss is returned as a miss, with the generation /
// suitability evidence that best explains it. Nothing in this file
// tunes authors, brain or shaping.

import { authorCandidates, fxKindsOfRecipe, isFxDressed } from "../authors";
import { createBrain, suitabilityOf } from "../brain";
import type { TrackFacts } from "../facts";
import type { JoinRecipe } from "../recipe";
import {
  FX_KINDS,
  JOG_KINDS,
  JOIN_FAMILIES,
  SCRATCH_TECHNIQUES,
} from "../recipe";
import {
  NEUTRAL_SLIDERS,
  PERSONALITY_IDS,
  resolveShaping,
  type PersonalityId,
  type Shaping,
} from "../shaping";
import { fixtureFacts, fixturePlaylists, fixtureTracks } from "./fixtures";

// ---------------------------------------------------------------------
// Seeded RNG (mulberry32 — the same generator brain.test.ts uses)
// ---------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------
// Run plan (stated constants — the methodology the report quotes)
// ---------------------------------------------------------------------

/** Seeds for the official runs: three independent streams. */
export const DISTRIBUTION_SEEDS: readonly number[] = [101, 202, 303];
/** Draws per arc pair, per seed. */
export const ARC_DRAWS_PER_SEED = 8;
/** Draws per matrix pair, per seed. */
export const MATRIX_DRAWS_PER_SEED = 2;
/** Arc position used for matrix pairs (mid-arc, neutral). */
export const MATRIX_ARC_POSITION = 0.5;

export interface DistributionConfig {
  id: PersonalityId;
  shaping: Shaping;
}

export const DISTRIBUTION_CONFIGS: DistributionConfig[] = PERSONALITY_IDS.map(
  (id) => ({ id, shaping: resolveShaping(id, NEUTRAL_SLIDERS) }),
);

// ---------------------------------------------------------------------
// Pair jobs: the arcs' consecutive pairs + the rest of the matrix
// ---------------------------------------------------------------------

export interface PairJob {
  aId: string;
  bId: string;
  arcPosition: number;
  source: "arc" | "matrix";
  arcName?: string;
}

const pairKey = (aId: string, bId: string): string => `${aId}→${bId}`;

export function buildPairJobs(): PairJob[] {
  const jobs: PairJob[] = [];
  const arcPairs = new Set<string>();
  for (const arc of fixturePlaylists) {
    for (let i = 0; i + 1 < arc.trackIds.length; i += 1) {
      const aId = arc.trackIds[i];
      const bId = arc.trackIds[i + 1];
      arcPairs.add(pairKey(aId, bId));
      jobs.push({
        aId,
        bId,
        arcPosition:
          arc.trackIds.length <= 1 ? 0 : i / (arc.trackIds.length - 1),
        source: "arc",
        arcName: arc.name,
      });
    }
  }
  for (const a of fixtureTracks) {
    for (const b of fixtureTracks) {
      if (a.id === b.id) continue;
      if (arcPairs.has(pairKey(a.id, b.id))) continue;
      jobs.push({
        aId: a.id,
        bId: b.id,
        arcPosition: MATRIX_ARC_POSITION,
        source: "matrix",
      });
    }
  }
  return jobs;
}

/** Every ordered pair (A ≠ B) in the library: the full matrix. */
export function allOrderedPairs(): { aId: string; bId: string }[] {
  const pairs: { aId: string; bId: string }[] = [];
  for (const a of fixtureTracks) {
    for (const b of fixtureTracks) {
      if (a.id !== b.id) pairs.push({ aId: a.id, bId: b.id });
    }
  }
  return pairs;
}

// ---------------------------------------------------------------------
// Tallies
// ---------------------------------------------------------------------

function zeroRecord(keys: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = 0;
  return out;
}

export interface DrawTally {
  /** Total consider() calls (draws attempted). */
  draws: number;
  /** consider() returned null — no candidate at/above the pool floor. */
  nullDraws: number;
  /** Drawn joins by recipe family (the performed-family distribution). */
  familyCounts: Record<string, number>;
  /** Drawn joins by recipe technique (scratch families). */
  techniqueCounts: Record<string, number>;
  /** Drawn joins containing ≥1 jog block of the kind (per-join). */
  jogKindCounts: Record<string, number>;
  /** Drawn joins containing ≥1 fx block of the kind (per-join). */
  fxKindCounts: Record<string, number>;
  /** Drawn joins carrying any fx dressing. */
  fxDressedDraws: number;
  /** Drawn joins that are theatre: stop-exit, scratch-*, or fx-dressed. */
  theatreDraws: number;
  /** Draws whose pair GENERATED a theatre candidate (T2 denominator). */
  theatreSupportedDraws: number;
  /** Theatre draws among the theatre-supported draws (T2 numerator). */
  theatreSupportedTheatreDraws: number;
  /** Drawn joins in a scratch family (scratch-in / scratch-out). */
  scratchJoins: number;
  /** Scratch-technique counts are techniqueCounts over scratchJoins. */
  /** Drawn joins containing a nudge jog block. */
  nudgeJoins: number;
  /** Drawn joins in scratch families or stop-exit (Battle T4 share). */
  scratchOrStopDraws: number;
  suitabilitySum: number;
  poolSizeSum: number;
  /** Mean blend length evidence: overlapBeats over family=blend draws. */
  blendOverlapSum: number;
  blendDraws: number;
  overlapSum: number;
}

export function createDrawTally(): DrawTally {
  return {
    draws: 0,
    nullDraws: 0,
    familyCounts: zeroRecord(JOIN_FAMILIES),
    techniqueCounts: zeroRecord(SCRATCH_TECHNIQUES),
    jogKindCounts: zeroRecord(JOG_KINDS),
    fxKindCounts: zeroRecord(FX_KINDS),
    fxDressedDraws: 0,
    theatreDraws: 0,
    theatreSupportedDraws: 0,
    theatreSupportedTheatreDraws: 0,
    scratchJoins: 0,
    nudgeJoins: 0,
    scratchOrStopDraws: 0,
    suitabilitySum: 0,
    poolSizeSum: 0,
    blendOverlapSum: 0,
    blendDraws: 0,
    overlapSum: 0,
  };
}

export function isTheatreRecipe(recipe: JoinRecipe): boolean {
  return (
    recipe.family === "stop-exit" ||
    recipe.family === "scratch-in" ||
    recipe.family === "scratch-out" ||
    isFxDressed(recipe)
  );
}

function tallyRecipe(
  tally: DrawTally,
  recipe: JoinRecipe,
  suitability: number,
  poolSize: number,
  theatreSupported: boolean,
): void {
  tally.familyCounts[recipe.family] =
    (tally.familyCounts[recipe.family] ?? 0) + 1;
  if (recipe.technique !== undefined) {
    tally.techniqueCounts[recipe.technique] =
      (tally.techniqueCounts[recipe.technique] ?? 0) + 1;
  }
  const jogKinds = new Set<string>();
  for (const block of recipe.blocks) {
    if (block.type === "jog") jogKinds.add(block.kind);
  }
  for (const kind of jogKinds) tally.jogKindCounts[kind] += 1;
  if (jogKinds.has("nudge")) tally.nudgeJoins += 1;
  const fxKinds = fxKindsOfRecipe(recipe);
  for (const kind of fxKinds) tally.fxKindCounts[kind] += 1;
  const dressed = fxKinds.length > 0;
  if (dressed) tally.fxDressedDraws += 1;
  const theatre = isTheatreRecipe(recipe);
  if (theatre) tally.theatreDraws += 1;
  if (theatreSupported) {
    tally.theatreSupportedDraws += 1;
    if (theatre) tally.theatreSupportedTheatreDraws += 1;
  }
  if (recipe.family === "scratch-in" || recipe.family === "scratch-out") {
    tally.scratchJoins += 1;
  }
  if (
    recipe.family === "scratch-in" ||
    recipe.family === "scratch-out" ||
    recipe.family === "stop-exit"
  ) {
    tally.scratchOrStopDraws += 1;
  }
  tally.suitabilitySum += suitability;
  tally.poolSizeSum += poolSize;
  tally.overlapSum += recipe.overlapBeats;
  if (recipe.family === "blend") {
    tally.blendOverlapSum += recipe.overlapBeats;
    tally.blendDraws += 1;
  }
}

function mergeTally(into: DrawTally, from: DrawTally): void {
  into.draws += from.draws;
  into.nullDraws += from.nullDraws;
  for (const key of Object.keys(from.familyCounts)) {
    into.familyCounts[key] =
      (into.familyCounts[key] ?? 0) + from.familyCounts[key];
  }
  for (const key of Object.keys(from.techniqueCounts)) {
    into.techniqueCounts[key] =
      (into.techniqueCounts[key] ?? 0) + from.techniqueCounts[key];
  }
  for (const key of Object.keys(from.jogKindCounts)) {
    into.jogKindCounts[key] =
      (into.jogKindCounts[key] ?? 0) + from.jogKindCounts[key];
  }
  for (const key of Object.keys(from.fxKindCounts)) {
    into.fxKindCounts[key] =
      (into.fxKindCounts[key] ?? 0) + from.fxKindCounts[key];
  }
  into.fxDressedDraws += from.fxDressedDraws;
  into.theatreDraws += from.theatreDraws;
  into.theatreSupportedDraws += from.theatreSupportedDraws;
  into.theatreSupportedTheatreDraws += from.theatreSupportedTheatreDraws;
  into.scratchJoins += from.scratchJoins;
  into.nudgeJoins += from.nudgeJoins;
  into.scratchOrStopDraws += from.scratchOrStopDraws;
  into.suitabilitySum += from.suitabilitySum;
  into.poolSizeSum += from.poolSizeSum;
  into.blendOverlapSum += from.blendOverlapSum;
  into.blendDraws += from.blendDraws;
  into.overlapSum += from.overlapSum;
}

// ---------------------------------------------------------------------
// Generation stats (authors under a configuration's shaping)
// ---------------------------------------------------------------------

export interface GenerationStats {
  jobs: number;
  totalCandidates: number;
  totalRejected: number;
  theatreSupportedJobs: number;
  candidateCountsByFamily: Record<string, number>;
  candidateCountsByTechnique: Record<string, number>;
  /** Candidates (documents) containing ≥1 jog block of the kind. */
  candidateCountsByJogKind: Record<string, number>;
  /** Candidates (documents) containing ≥1 fx block of the kind. */
  candidateCountsByFxKind: Record<string, number>;
  /** Candidates that are fx-dressed documents. */
  fxDressedCandidates: number;
  /** Fx-dressed candidates split by the family they ride on. */
  fxDressedByFamily: Record<string, number>;
  /**
   * Author rejection reasons by family, normalised (numbers → #)
   * so identical wordings group: the evidence for WHY a family or
   * technique was not generated on this library.
   */
  rejectedReasonsByFamily: Record<string, Record<string, number>>;
  suitabilitySumByFamily: Record<string, number>;
}

/** Groups rejection wordings that differ only in their numbers. */
export function normaliseReason(reason: string): string {
  return reason.replace(/\d+(\.\d+)?/g, "#");
}

export function createGenerationStats(jobs: number): GenerationStats {
  return {
    jobs,
    totalCandidates: 0,
    totalRejected: 0,
    theatreSupportedJobs: 0,
    candidateCountsByFamily: zeroRecord(JOIN_FAMILIES),
    candidateCountsByTechnique: zeroRecord(SCRATCH_TECHNIQUES),
    candidateCountsByJogKind: zeroRecord(JOG_KINDS),
    candidateCountsByFxKind: zeroRecord(FX_KINDS),
    fxDressedCandidates: 0,
    fxDressedByFamily: zeroRecord(JOIN_FAMILIES),
    rejectedReasonsByFamily: {},
    suitabilitySumByFamily: zeroRecord(JOIN_FAMILIES),
  };
}

// ---------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------

export interface ConfigDistribution {
  configId: PersonalityId;
  generation: GenerationStats;
  /** Aggregate over all seeds. */
  tally: DrawTally;
  /** One tally per seed, in DISTRIBUTION_SEEDS order. */
  perSeed: DrawTally[];
}

export interface DistributionRun {
  seeds: readonly number[];
  jobs: PairJob[];
  arcJobs: number;
  matrixJobs: number;
  drawsPerConfigPerSeed: number;
  configs: ConfigDistribution[];
}

function factsOrThrow(id: string): TrackFacts {
  const facts = fixtureFacts.get(id);
  if (!facts) throw new Error(`distribution: no fixture facts for ${id}`);
  return facts;
}

export function runBrainDistribution(): DistributionRun {
  const jobs = buildPairJobs();
  const arcJobs = jobs.filter((j) => j.source === "arc").length;
  const matrixJobs = jobs.length - arcJobs;
  const drawsPerSeed =
    arcJobs * ARC_DRAWS_PER_SEED + matrixJobs * MATRIX_DRAWS_PER_SEED;

  const configs: ConfigDistribution[] = [];
  for (const config of DISTRIBUTION_CONFIGS) {
    // Generation pass: authors run ONCE per job under this shaping;
    // theatre support is a property of the authored candidate set.
    const generation = createGenerationStats(jobs.length);
    const theatreSupportedByJob: boolean[] = [];
    for (const job of jobs) {
      const { candidates, rejected } = authorCandidates(
        factsOrThrow(job.aId),
        factsOrThrow(job.bId),
        { arcPosition: job.arcPosition, shaping: config.shaping },
      );
      generation.totalCandidates += candidates.length;
      generation.totalRejected += rejected.length;
      for (const rejection of rejected) {
        const byReason = (generation.rejectedReasonsByFamily[
          rejection.family
        ] ??= {});
        const key = normaliseReason(rejection.reason);
        byReason[key] = (byReason[key] ?? 0) + 1;
      }
      let theatre = false;
      for (const candidate of candidates) {
        generation.candidateCountsByFamily[candidate.family] =
          (generation.candidateCountsByFamily[candidate.family] ?? 0) + 1;
        generation.suitabilitySumByFamily[candidate.family] =
          (generation.suitabilitySumByFamily[candidate.family] ?? 0) +
          suitabilityOf(candidate);
        if (candidate.technique !== undefined) {
          generation.candidateCountsByTechnique[candidate.technique] =
            (generation.candidateCountsByTechnique[candidate.technique] ?? 0) +
            1;
        }
        const jogKinds = new Set<string>();
        for (const block of candidate.blocks) {
          if (block.type === "jog") jogKinds.add(block.kind);
        }
        for (const kind of jogKinds) {
          generation.candidateCountsByJogKind[kind] += 1;
        }
        const fxKinds = fxKindsOfRecipe(candidate);
        for (const kind of fxKinds) {
          generation.candidateCountsByFxKind[kind] += 1;
        }
        if (fxKinds.length > 0) {
          generation.fxDressedCandidates += 1;
          generation.fxDressedByFamily[candidate.family] =
            (generation.fxDressedByFamily[candidate.family] ?? 0) + 1;
        }
        if (isTheatreRecipe(candidate)) theatre = true;
      }
      theatreSupportedByJob.push(theatre);
      if (theatre) generation.theatreSupportedJobs += 1;
    }

    // Draw pass: a fresh seeded brain per seed; each job is drawn
    // the stated number of times, in job order, off one RNG stream.
    const perSeed: DrawTally[] = [];
    const aggregate = createDrawTally();
    for (const seed of DISTRIBUTION_SEEDS) {
      const brain = createBrain({ rng: mulberry32(seed) });
      const tally = createDrawTally();
      for (let jobIndex = 0; jobIndex < jobs.length; jobIndex += 1) {
        const job = jobs[jobIndex];
        const repeats =
          job.source === "arc" ? ARC_DRAWS_PER_SEED : MATRIX_DRAWS_PER_SEED;
        for (let r = 0; r < repeats; r += 1) {
          tally.draws += 1;
          const result = brain.consider({
            factsA: factsOrThrow(job.aId),
            optionsB: [factsOrThrow(job.bId)],
            arcPosition: job.arcPosition,
            shaping: config.shaping,
          });
          if (result === null) {
            tally.nullDraws += 1;
            if (theatreSupportedByJob[jobIndex]) {
              tally.theatreSupportedDraws += 1;
            }
            continue;
          }
          tallyRecipe(
            tally,
            result.recipe,
            result.suitability,
            result.poolSize,
            theatreSupportedByJob[jobIndex],
          );
        }
      }
      perSeed.push(tally);
      mergeTally(aggregate, tally);
    }
    configs.push({
      configId: config.id,
      generation,
      tally: aggregate,
      perSeed,
    });
  }

  return {
    seeds: DISTRIBUTION_SEEDS,
    jobs,
    arcJobs,
    matrixJobs,
    drawsPerConfigPerSeed: drawsPerSeed,
    configs,
  };
}

// ---------------------------------------------------------------------
// T6 — determinism: same seed ⇒ identical sequence
// ---------------------------------------------------------------------

export interface DeterminismCheck {
  identical: boolean;
  sequenceLength: number;
  distinctFamilies: number;
  first: string[];
  second: string[];
}

/** Draws the first 60 jobs twice off the same seed and compares. */
export function runDeterminismCheck(seed = 4242): DeterminismCheck {
  const jobs = buildPairJobs().slice(0, 60);
  const shaping = resolveShaping("autonomous", NEUTRAL_SLIDERS);
  const drawSequence = (): string[] => {
    const brain = createBrain({ rng: mulberry32(seed) });
    const sequence: string[] = [];
    for (const job of jobs) {
      for (let r = 0; r < 3; r += 1) {
        const result = brain.consider({
          factsA: factsOrThrow(job.aId),
          optionsB: [factsOrThrow(job.bId)],
          arcPosition: job.arcPosition,
          shaping,
        });
        sequence.push(
          result === null
            ? "null"
            : `${result.trackB.trackId}|${result.recipe.family}|${result.recipe.technique ?? ""}|${result.recipe.id}`,
        );
      }
    }
    return sequence;
  };
  const first = drawSequence();
  const second = drawSequence();
  const families = new Set(
    first
      .filter((entry) => entry !== "null")
      .map((entry) => entry.split("|")[1]),
  );
  return {
    identical:
      first.length === second.length &&
      first.every((entry, i) => entry === second[i]),
    sequenceLength: first.length,
    distinctFamilies: families.size,
    first,
    second,
  };
}

// ---------------------------------------------------------------------
// Derived shares
// ---------------------------------------------------------------------

export interface TallyShares {
  joins: number;
  familyShare: Record<string, number>;
  theatreShare: number;
  theatreOnSupportedShare: number | null;
  scratchOrStopShare: number;
  fxDressedShare: number;
  nudgeShare: number;
  techniqueShareOfScratch: Record<string, number>;
  meanSuitability: number;
  meanPoolSize: number;
  meanBlendBeats: number | null;
  meanOverlapBeats: number;
}

export function sharesOf(tally: DrawTally): TallyShares {
  const joins = tally.draws - tally.nullDraws;
  const share = (count: number): number => (joins > 0 ? count / joins : 0);
  const familyShare: Record<string, number> = {};
  for (const family of JOIN_FAMILIES) {
    familyShare[family] = share(tally.familyCounts[family] ?? 0);
  }
  const techniqueShareOfScratch: Record<string, number> = {};
  for (const technique of SCRATCH_TECHNIQUES) {
    techniqueShareOfScratch[technique] =
      tally.scratchJoins > 0
        ? (tally.techniqueCounts[technique] ?? 0) / tally.scratchJoins
        : 0;
  }
  return {
    joins,
    familyShare,
    theatreShare: share(tally.theatreDraws),
    theatreOnSupportedShare:
      tally.theatreSupportedDraws > 0
        ? tally.theatreSupportedTheatreDraws / tally.theatreSupportedDraws
        : null,
    scratchOrStopShare: share(tally.scratchOrStopDraws),
    fxDressedShare: share(tally.fxDressedDraws),
    nudgeShare: share(tally.nudgeJoins),
    techniqueShareOfScratch,
    meanSuitability: joins > 0 ? tally.suitabilitySum / joins : 0,
    meanPoolSize: joins > 0 ? tally.poolSizeSum / joins : 0,
    meanBlendBeats:
      tally.blendDraws > 0 ? tally.blendOverlapSum / tally.blendDraws : null,
    meanOverlapBeats: joins > 0 ? tally.overlapSum / joins : 0,
  };
}

// ---------------------------------------------------------------------
// Target scoring — T1–T4 (T5/T6 are scored where their evidence lives)
// ---------------------------------------------------------------------

export interface TargetVerdict {
  id: string;
  target: string;
  met: boolean;
  /** The actual numbers, counts first. */
  actual: string;
  /** Evidence-based account, naming the driving component/term. */
  diagnosis: string;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function byId(run: DistributionRun, id: PersonalityId): ConfigDistribution {
  const found = run.configs.find((c) => c.configId === id);
  if (!found) throw new Error(`distribution: missing config ${id}`);
  return found;
}

function meanSuitabilityOfFamily(
  config: ConfigDistribution,
  family: string,
): number {
  const count = config.generation.candidateCountsByFamily[family] ?? 0;
  return count > 0
    ? (config.generation.suitabilitySumByFamily[family] ?? 0) / count
    : 0;
}

export function scoreBrainTargets(run: DistributionRun): TargetVerdict[] {
  const verdicts: TargetVerdict[] = [];
  const autonomous = byId(run, "autonomous");
  const auto = sharesOf(autonomous.tally);

  // T1 — autonomous: no family > 45%.
  const topFamily = JOIN_FAMILIES.map((family) => ({
    family,
    share: auto.familyShare[family],
    count: autonomous.tally.familyCounts[family] ?? 0,
  })).sort((a, z) => z.share - a.share)[0];
  verdicts.push({
    id: "T1",
    target: "Autonomous: no join family exceeds 45% of drawn joins.",
    met: topFamily.share <= 0.45,
    actual: `Largest family is ${topFamily.family} at ${topFamily.count}/${auto.joins} joins (${pct(topFamily.share)}).`,
    diagnosis:
      `Generation-side, ${topFamily.family} is ` +
      `${autonomous.generation.candidateCountsByFamily[topFamily.family]} of ` +
      `${autonomous.generation.totalCandidates} authored candidates across ` +
      `${autonomous.generation.jobs} jobs, with mean authored suitability ` +
      `${meanSuitabilityOfFamily(autonomous, topFamily.family).toFixed(3)} — ` +
      `the draw is ∝ suitability² × affinity (autonomous affinity = 1), so ` +
      `candidate volume × suitability is the whole story. (Wave 7 ` +
      `corrections, measured in the addendum to the Wave 5 report: ` +
      `echo-out is now evidence-gated on the outgoing tail — length ` +
      `and energy at the exit window — and fx dressings author only ` +
      `on a standard-blend host, so no family receives an ` +
      `unconditional per-job document or a dressing-overflow ` +
      `multiplier. In this run, fx-dressed echo-out candidates: ` +
      `${autonomous.generation.fxDressedByFamily["echo-out"]} of ` +
      `${autonomous.generation.candidateCountsByFamily["echo-out"]}.)`,
  });

  // T2 — theatre ≥ 25% on theatre-supporting pairs (autonomous).
  const t2Share = auto.theatreOnSupportedShare ?? 0;
  verdicts.push({
    id: "T2",
    target:
      "Autonomous: theatre (stop-exit + scratch families + fx-dressed) ≥ 25% of joins on pairs that generated theatre candidates.",
    met: t2Share >= 0.25,
    actual:
      `${autonomous.tally.theatreSupportedTheatreDraws}/` +
      `${autonomous.tally.theatreSupportedDraws} draws on theatre-supporting ` +
      `pairs were theatre (${pct(t2Share)}); theatre-supporting jobs: ` +
      `${autonomous.generation.theatreSupportedJobs}/${autonomous.generation.jobs}. ` +
      `Theatre overall: ${autonomous.tally.theatreDraws}/${auto.joins} (${pct(auto.theatreShare)}).`,
    diagnosis:
      `Theatre candidates authored (autonomous): stop-exit ` +
      `${autonomous.generation.candidateCountsByFamily["stop-exit"]}, ` +
      `scratch-in ${autonomous.generation.candidateCountsByFamily["scratch-in"]}, ` +
      `scratch-out ${autonomous.generation.candidateCountsByFamily["scratch-out"]}, ` +
      `fx-dressed documents ${autonomous.generation.fxDressedCandidates} of ` +
      `${autonomous.generation.totalCandidates} candidates. The theatre ` +
      `share is carried by the legs that exist on this library: scratch ` +
      `joins, fx-dressed joins, and stop-exit joins where a measured, ` +
      `falling outro supports them (stop-exit candidates above). ` +
      `Mean authored suitability of the theatre legs that do exist: ` +
      `scratch-in ${meanSuitabilityOfFamily(autonomous, "scratch-in").toFixed(3)}, ` +
      `scratch-out ${meanSuitabilityOfFamily(autonomous, "scratch-out").toFixed(3)} ` +
      `(blend, for contrast: ${meanSuitabilityOfFamily(autonomous, "blend").toFixed(3)}).`,
  });

  // T3 — every scratch technique ≥ 1% of scratch joins; nudge ≥ 3%.
  const techniqueLines = SCRATCH_TECHNIQUES.map((technique) => ({
    technique,
    count: autonomous.tally.techniqueCounts[technique] ?? 0,
    share: auto.techniqueShareOfScratch[technique],
  }));
  const weakestTechnique = [...techniqueLines].sort(
    (a, z) => a.share - z.share,
  )[0];
  const t3Met =
    techniqueLines.every((line) => line.share >= 0.01) &&
    auto.nudgeShare >= 0.03;
  verdicts.push({
    id: "T3",
    target:
      "Autonomous: every scratch technique ≥ 1% of scratch joins; nudge blocks in ≥ 3% of all joins.",
    met: t3Met,
    actual:
      `Scratch joins: ${autonomous.tally.scratchJoins}. Per technique: ` +
      techniqueLines
        .map((line) => `${line.technique} ${line.count} (${pct(line.share)})`)
        .join(", ") +
      `. Nudge joins: ${autonomous.tally.nudgeJoins}/${auto.joins} (${pct(auto.nudgeShare)}).`,
    diagnosis:
      `Generation-side (autonomous), candidates per technique: ` +
      SCRATCH_TECHNIQUES.map(
        (t) => `${t} ${autonomous.generation.candidateCountsByTechnique[t]}`,
      ).join(", ") +
      `; nudge-bearing candidates: ${autonomous.generation.candidateCountsByJogKind.nudge}. ` +
      `Technique feasibility is window-evidence-gated in the authors ` +
      `(transient floors: crab 0.50, transformer 0.45, flare 0.40, chirp 0.35, ` +
      `baby 0.30 — see authors.ts SCRATCH_TRANSIENT_FLOORS), so a technique ` +
      `with thin generation has thin draw share by construction; the weakest ` +
      `drawn technique is ${weakestTechnique.technique} at ${pct(weakestTechnique.share)}.`,
  });

  // T4 — personality contrasts.
  const battle = sharesOf(byId(run, "battle").tally);
  const radio = sharesOf(byId(run, "radio").tally);
  const house = sharesOf(byId(run, "house").tally);
  const club = sharesOf(byId(run, "club").tally);
  const battleRatio =
    auto.scratchOrStopShare > 0
      ? battle.scratchOrStopShare / auto.scratchOrStopShare
      : 0;
  const t4Parts = {
    battle: battleRatio >= 1.5,
    radio: radio.theatreShare < auto.theatreShare && radio.theatreShare >= 0.03,
    house: (house.meanBlendBeats ?? 0) > (auto.meanBlendBeats ?? 0),
    club: club.fxDressedShare > auto.fxDressedShare,
  };
  verdicts.push({
    id: "T4",
    target:
      "Battle scratch+stop share ≥ 1.5× autonomous; Radio theatre < autonomous but ≥ 3%; House mean blend length > autonomous; Club fx share > autonomous.",
    met: Object.values(t4Parts).every(Boolean),
    actual:
      `Battle scratch+stop ${pct(battle.scratchOrStopShare)} vs autonomous ` +
      `${pct(auto.scratchOrStopShare)} (ratio ${battleRatio.toFixed(2)}×) — ` +
      `${t4Parts.battle ? "MET" : "MISSED"}. Radio theatre ` +
      `${pct(radio.theatreShare)} vs autonomous ${pct(auto.theatreShare)} — ` +
      `${t4Parts.radio ? "MET" : "MISSED"}. House mean blend ` +
      `${house.meanBlendBeats?.toFixed(1)} beats vs autonomous ` +
      `${auto.meanBlendBeats?.toFixed(1)} — ${t4Parts.house ? "MET" : "MISSED"}. ` +
      `Club fx-dressed ${pct(club.fxDressedShare)} vs autonomous ` +
      `${pct(auto.fxDressedShare)} — ${t4Parts.club ? "MET" : "MISSED"}.`,
    diagnosis:
      `Shaping levers behind the four contrasts — Battle: scratch-in/out ` +
      `affinity 1.7, stop-exit 1.6, scratchDensity bend 1.8. Radio: theatre ` +
      `affinities at the 0.6 band floor, fx 0.6, scratchDensity 0.6. House: ` +
      `blendBeatsCentre 32 vs autonomous 16 (blend candidates are authored ` +
      `at short/standard/long centres scaled by centre/16). Club: fx affinity ` +
      `1.5 and fxDensity 1.5 vs autonomous 1.0. A missed contrast means the ` +
      `affinity/bend lever was smaller than the suitability² evidence term ` +
      `it had to move.`,
  });

  return verdicts;
}

// ---------------------------------------------------------------------
// Session-simulation summary (produced by distribution.test.ts)
// ---------------------------------------------------------------------

export interface SessionConfigSummary {
  configId: PersonalityId;
  arcsCompleted: number;
  arcsTotal: number;
  totalRecords: number;
  byReason: Record<string, number>;
  byFamily: Record<string, number>;
  /** Records with reason fallback-* (the plain cuts). */
  plainCuts: number;
  /** Joins the performer actually performed (performRecipe calls). */
  performedJoins: number;
  performedFamilyCounts: Record<string, number>;
  performedTechniqueCounts: Record<string, number>;
  performedJogKindCounts: Record<string, number>;
  performedFxKindCounts: Record<string, number>;
  userActRecords: number;
}

export function scoreSessionTarget(
  sessions: SessionConfigSummary[],
): TargetVerdict {
  const totalPlain = sessions.reduce((sum, s) => sum + s.plainCuts, 0);
  const totalRecords = sessions.reduce((sum, s) => sum + s.totalRecords, 0);
  const fallbackReasons = sessions
    .flatMap((s) =>
      Object.entries(s.byReason)
        .filter(([reason]) => reason.startsWith("fallback-"))
        .map(([reason, count]) => `${reason} ×${count}`),
    )
    .join(", ");
  const degraded = sessions.reduce(
    (sum, s) => sum + (s.byReason["degraded-untrusted"] ?? 0),
    0,
  );
  return {
    id: "T5",
    target:
      "Session simulation: ZERO plain cuts for prepared pairs; every degradation recorded with its reason.",
    met: totalPlain === 0,
    actual:
      `${totalRecords} behaviour records across ${sessions.length} ` +
      `configurations × 5 arcs; plain cuts (fallback-* records): ${totalPlain}` +
      (fallbackReasons ? ` (${fallbackReasons})` : "") +
      `; degraded-untrusted records: ${degraded} (each carries its reason ` +
      `in the record and a narration event in the activity feed).`,
    diagnosis:
      totalPlain === 0
        ? "Every pair in the simulation was prepared by the fake source/supply (facts + decoded buffer), and the session committed a drawn recipe for every join — no deck-end, buy-time or invalid-draw path was ever reached."
        : "Plain cuts in a fully-prepared simulation come from the session's terminal paths (deck-end with no committed join, buy-time exhaustion, or a second invalid draw) — the per-configuration table names which configurations produced them; the brain-level evidence above shows whether the underlying pairs had any pool candidate at all (null draws).",
  };
}

// ---------------------------------------------------------------------
// Per-technique autonomous reachability (§0b — three legs)
// ---------------------------------------------------------------------

export interface ReachabilityRow {
  kind: "family" | "scratch-technique" | "jog-kind" | "fx-kind";
  name: string;
  /** Candidates authored under autonomous (neutral) shaping. */
  generatedCandidates: number;
  /** Drawn joins carrying it in the autonomous distribution run. */
  drawnJoins: number;
  /** Joins the performer performed with it in autonomous session sims. */
  performedJoins: number;
  reachable: boolean;
}

export function buildReachability(
  autonomous: ConfigDistribution,
  session: SessionConfigSummary,
): ReachabilityRow[] {
  const rows: ReachabilityRow[] = [];
  const push = (
    kind: ReachabilityRow["kind"],
    name: string,
    generated: number,
    drawn: number,
    performed: number,
  ): void => {
    rows.push({
      kind,
      name,
      generatedCandidates: generated,
      drawnJoins: drawn,
      performedJoins: performed,
      reachable: generated > 0 && drawn > 0 && performed > 0,
    });
  };
  for (const family of JOIN_FAMILIES) {
    push(
      "family",
      family,
      autonomous.generation.candidateCountsByFamily[family] ?? 0,
      autonomous.tally.familyCounts[family] ?? 0,
      session.performedFamilyCounts[family] ?? 0,
    );
  }
  for (const technique of SCRATCH_TECHNIQUES) {
    push(
      "scratch-technique",
      technique,
      autonomous.generation.candidateCountsByTechnique[technique] ?? 0,
      autonomous.tally.techniqueCounts[technique] ?? 0,
      session.performedTechniqueCounts[technique] ?? 0,
    );
  }
  for (const kind of JOG_KINDS) {
    push(
      "jog-kind",
      kind,
      autonomous.generation.candidateCountsByJogKind[kind] ?? 0,
      autonomous.tally.jogKindCounts[kind] ?? 0,
      session.performedJogKindCounts[kind] ?? 0,
    );
  }
  for (const kind of FX_KINDS) {
    push(
      "fx-kind",
      kind,
      autonomous.generation.candidateCountsByFxKind[kind] ?? 0,
      autonomous.tally.fxKindCounts[kind] ?? 0,
      session.performedFxKindCounts[kind] ?? 0,
    );
  }
  return rows;
}

// ---------------------------------------------------------------------
// Markdown rendering (the investigation report)
// ---------------------------------------------------------------------

export interface ReportInputs {
  analyserGate: string;
  run: DistributionRun;
  brainVerdicts: TargetVerdict[];
  sessions: SessionConfigSummary[];
  sessionVerdict: TargetVerdict;
  determinism: DeterminismCheck;
  reachability: ReachabilityRow[];
}

function shareCell(count: number, total: number): string {
  return total > 0 ? `${count} (${pct(count / total)})` : `${count}`;
}

export function renderDistributionMarkdown(inputs: ReportInputs): string {
  const { run } = inputs;
  const lines: string[] = [];
  lines.push("# liveRave — Distribution Results (Wave 5)");
  lines.push("");
  lines.push(
    "Measured behaviour of the NEW autonomous engine. Standing orders applied: " +
      "automatic-first (only the autonomous draw and the autonomous session are " +
      "measured; no manual call appears anywhere in these runs), no rebuild " +
      "framing, and misses are reported plainly with their numbers — nothing " +
      "was tuned to hit a target during this wave.",
  );
  lines.push("");
  lines.push("## Honesty gate — the analyser");
  lines.push("");
  lines.push(inputs.analyserGate);
  lines.push("");
  lines.push("## Methodology");
  lines.push("");
  lines.push(
    `- Fixture library: ${fixtureTracks.length} synthetic tracks ` +
      `(harness/fixtures.ts), reads computed at import by the NEW ` +
      `analyseSamples at deep depth; facts via buildTrackFacts.`,
  );
  lines.push(
    `- Pair jobs: ${run.arcJobs} arc jobs (consecutive pairs along the ` +
      `${fixturePlaylists.length} playlist arcs, each at its arc position) + ` +
      `${run.matrixJobs} matrix jobs (every remaining ordered pair A≠B of the ` +
      `${fixtureTracks.length}×${fixtureTracks.length - 1} = ` +
      `${fixtureTracks.length * (fixtureTracks.length - 1)} ordered-pair ` +
      `matrix, at arc position ${MATRIX_ARC_POSITION}). Total jobs per ` +
      `configuration: ${run.jobs.length} — the full ordered-pair matrix is covered.`,
  );
  lines.push(
    `- Draws: seeds ${run.seeds.join(", ")}; per seed per configuration: ` +
      `${ARC_DRAWS_PER_SEED} draws per arc job + ${MATRIX_DRAWS_PER_SEED} per ` +
      `matrix job = ${run.drawsPerConfigPerSeed} draws; per configuration ` +
      `across seeds: ${run.drawsPerConfigPerSeed * run.seeds.length} draws; ` +
      `grand total: ${run.drawsPerConfigPerSeed * run.seeds.length * run.configs.length} ` +
      `brain.consider() calls. Each draw is a single-option consider ` +
      `(optionsB = the job's B track), so the drawn recipe is a pure pair-join ` +
      `draw; track choice is exercised separately by the session simulation. ` +
      `No performance memory is injected into the brain runs (memory only ` +
      `damps toward a 0.55 floor; the shaped evidence draw is what the ` +
      `personalities change).`,
  );
  lines.push(
    "- Configurations: autonomous + club, battle, house, open-format, " +
      "experimental, radio — each resolved via resolveShaping with all " +
      "eight sliders at neutral 0.5.",
  );
  lines.push(
    "- Generation pass: per configuration and job, authorCandidates ran " +
      "once; those candidate documents ground the theatre-support " +
      "denominator (T2), the generation column of the reachability table, " +
      "and the diagnoses.",
  );
  lines.push(
    "- Session simulation: the REAL session (createSession) driven by a " +
      "fake performer + fake source/supply over the fixture reads (the " +
      "session.test.ts fake patterns), once per configuration × arc, " +
      "autonomously from start to queue exhaustion; behaviour records are " +
      "the session's own behaviour log. No manual seam (skip, deck move, " +
      "seek) was called; user-act records must therefore be zero, and are " +
      "reported.",
  );
  lines.push(
    "- Brain-level fallback/plain-cut rate: the brain has no such concept. " +
      "consider() returns a drawn JoinRecipe or null; nulls are counted " +
      "below as their own outcome and are never substituted in these tallies.",
  );
  lines.push("");

  // Per-configuration tables
  lines.push("## Per-configuration results (brain draws)");
  for (const config of run.configs) {
    const shares = sharesOf(config.tally);
    const joins = shares.joins;
    lines.push("");
    lines.push(`### ${config.configId}`);
    lines.push("");
    lines.push(
      `Draws attempted: ${config.tally.draws}; null draws (no pool candidate): ` +
        `${config.tally.nullDraws}; joins drawn: ${joins}. Mean suitability ` +
        `${shares.meanSuitability.toFixed(3)}; mean pool size ` +
        `${shares.meanPoolSize.toFixed(1)}; mean overlap ` +
        `${shares.meanOverlapBeats.toFixed(1)} beats; mean blend length ` +
        `${shares.meanBlendBeats === null ? "n/a" : shares.meanBlendBeats.toFixed(1)} beats.`,
    );
    lines.push("");
    lines.push("| Family | Drawn joins | Share |");
    lines.push("|---|---:|---:|");
    for (const family of JOIN_FAMILIES) {
      lines.push(
        `| ${family} | ${config.tally.familyCounts[family] ?? 0} | ${pct(shares.familyShare[family])} |`,
      );
    }
    lines.push(
      `| **theatre (stop-exit + scratch + fx-dressed)** | ${config.tally.theatreDraws} | ${pct(shares.theatreShare)} |`,
    );
    lines.push(
      `| theatre on theatre-supporting pairs | ${config.tally.theatreSupportedTheatreDraws} / ${config.tally.theatreSupportedDraws} | ${shares.theatreOnSupportedShare === null ? "n/a" : pct(shares.theatreOnSupportedShare)} |`,
    );
    lines.push(
      `| fx-dressed | ${config.tally.fxDressedDraws} | ${pct(shares.fxDressedShare)} |`,
    );
    lines.push("");
    lines.push(
      `Scratch joins: ${config.tally.scratchJoins}. Per scratch technique ` +
        `(count, share of scratch joins): ` +
        SCRATCH_TECHNIQUES.map(
          (t) =>
            `${t} ${shareCell(config.tally.techniqueCounts[t] ?? 0, config.tally.scratchJoins)}`,
        ).join("; ") +
        ".",
    );
    lines.push("");
    lines.push(
      "Jog kinds (joins containing ≥1 block of the kind): " +
        JOG_KINDS.map(
          (k) => `${k} ${shareCell(config.tally.jogKindCounts[k] ?? 0, joins)}`,
        ).join("; ") +
        ".",
    );
    lines.push("");
    lines.push(
      "Fx kinds (joins containing ≥1 block of the kind): " +
        FX_KINDS.map(
          (k) => `${k} ${shareCell(config.tally.fxKindCounts[k] ?? 0, joins)}`,
        ).join("; ") +
        ".",
    );
    lines.push("");
    // Seed variance for the headline shares.
    const seedLines = config.perSeed.map((tally, i) => {
      const s = sharesOf(tally);
      return (
        `seed ${run.seeds[i]}: joins ${s.joins}, theatre ${pct(s.theatreShare)}, ` +
        `scratch+stop ${pct(s.scratchOrStopShare)}, fx-dressed ${pct(s.fxDressedShare)}, ` +
        `nulls ${tally.nullDraws}`
      );
    });
    lines.push(`Seed variance — ${seedLines.join(" · ")}.`);
    lines.push("");
    lines.push(
      `Generation (authors under ${config.configId} shaping): ` +
        `${config.generation.totalCandidates} candidates, ` +
        `${config.generation.totalRejected} rejected, across ` +
        `${config.generation.jobs} jobs; theatre-supporting jobs ` +
        `${config.generation.theatreSupportedJobs}. Candidates by family: ` +
        JOIN_FAMILIES.map(
          (f) => `${f} ${config.generation.candidateCountsByFamily[f] ?? 0}`,
        ).join(", ") +
        ".",
    );
  }

  // Cross-configuration note: open-format vs autonomous.
  const autoConfig = run.configs.find((c) => c.configId === "autonomous");
  const openConfig = run.configs.find((c) => c.configId === "open-format");
  if (autoConfig && openConfig) {
    const maxDiff = Math.max(
      ...JOIN_FAMILIES.map((family) =>
        Math.abs(
          (autoConfig.tally.familyCounts[family] ?? 0) -
            (openConfig.tally.familyCounts[family] ?? 0),
        ),
      ),
    );
    lines.push("");
    lines.push("## Note — open-format vs autonomous");
    lines.push("");
    lines.push(
      `Open-format's family counts differ from autonomous's by at most ` +
        `${maxDiff} joins in any family over ${autoConfig.tally.draws} draws. ` +
        `That is the shaping maths showing through: open-format's affinities ` +
        `are near-uniform (1.0–1.2), and a near-uniform affinity scaling ` +
        `barely moves a normalised suitability² draw; its distinctive bends ` +
        `(selectionFreedom 1.7, keyTempoTolerance 1.6) act on TRACK choice, ` +
        `which single-option pair draws do not exercise — the session ` +
        `simulation, where the brain ranks several options, is where those ` +
        `bends can bite.`,
    );
  }

  // Verdicts T1–T4
  lines.push("");
  lines.push("## Target verdicts — brain (design §5)");
  for (const verdict of inputs.brainVerdicts) {
    lines.push("");
    lines.push(`### ${verdict.id} — ${verdict.met ? "MET" : "MISSED"}`);
    lines.push("");
    lines.push(`Target: ${verdict.target}`);
    lines.push("");
    lines.push(`Actual: ${verdict.actual}`);
    lines.push("");
    lines.push(`Diagnosis: ${verdict.diagnosis}`);
  }

  // Session simulation
  lines.push("");
  lines.push("## Session simulation (T5 evidence)");
  lines.push("");
  lines.push(
    "| Configuration | Arcs completed | Records | Performed (record) | degraded-untrusted | fallback-unprepared | fallback-invalid | user-act | set-end | Plain cuts | Performed joins (performer) |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of inputs.sessions) {
    lines.push(
      `| ${s.configId} | ${s.arcsCompleted}/${s.arcsTotal} | ${s.totalRecords} | ` +
        `${s.byReason["performed"] ?? 0} | ${s.byReason["degraded-untrusted"] ?? 0} | ` +
        `${s.byReason["fallback-unprepared"] ?? 0} | ${s.byReason["fallback-invalid"] ?? 0} | ` +
        `${s.userActRecords} | ${s.byReason["set-end"] ?? 0} | ${s.plainCuts} | ${s.performedJoins} |`,
    );
  }
  lines.push("");
  lines.push(
    `### ${inputs.sessionVerdict.id} — ${inputs.sessionVerdict.met ? "MET" : "MISSED"}`,
  );
  lines.push("");
  lines.push(`Target: ${inputs.sessionVerdict.target}`);
  lines.push("");
  lines.push(`Actual: ${inputs.sessionVerdict.actual}`);
  lines.push("");
  lines.push(`Diagnosis: ${inputs.sessionVerdict.diagnosis}`);

  // T6
  lines.push("");
  lines.push("## T6 — determinism");
  lines.push("");
  lines.push(
    `Same seed (4242) drawn twice over the first 60 jobs × 3 draws: ` +
      `sequences identical = ${inputs.determinism.identical} over ` +
      `${inputs.determinism.sequenceLength} draws ` +
      `(${inputs.determinism.distinctFamilies} distinct families in the sequence). ` +
      `Verdict: ${inputs.determinism.identical ? "MET" : "MISSED"} — same seed ⇒ identical sequence.`,
  );

  // Generation evidence for the zero rows (autonomous shaping).
  if (autoConfig) {
    const gen = autoConfig.generation;
    const zeroFamilies = JOIN_FAMILIES.filter(
      (family) => (gen.candidateCountsByFamily[family] ?? 0) === 0,
    );
    const zeroTechniques = SCRATCH_TECHNIQUES.filter(
      (t) => (gen.candidateCountsByTechnique[t] ?? 0) === 0,
    );
    if (zeroFamilies.length > 0 || zeroTechniques.length > 0) {
      lines.push("");
      lines.push(
        "## Generation evidence — why the zero rows are zero (autonomous)",
      );
      lines.push("");
      lines.push(
        "The authors' own rejection records, grouped by wording (numbers " +
          "normalised to #). These are the evidence gates that fired on " +
          "this fixture library; the authors DID author these families " +
          "against the hand-built fixtures in authors.test.ts, so a zero " +
          "here is a property of the library's measured evidence meeting " +
          "the gates, recorded — not silently tuned around.",
      );
      const topReasons = (
        byReason: Record<string, number> | undefined,
        limit: number,
      ): string => {
        if (!byReason) return "no rejections recorded";
        const entries = Object.entries(byReason).sort((a, z) => z[1] - a[1]);
        if (entries.length === 0) return "no rejections recorded";
        return entries
          .slice(0, limit)
          .map(([reason, count]) => `${reason} ×${count}`)
          .join(" · ");
      };
      for (const family of zeroFamilies) {
        lines.push("");
        lines.push(
          `- **${family}** — 0 candidates. Top rejections: ` +
            topReasons(gen.rejectedReasonsByFamily[family], 3) +
            ".",
        );
      }
      if (zeroTechniques.length > 0) {
        lines.push("");
        lines.push(
          `- **scratch techniques ${zeroTechniques.join(", ")}** — 0 candidates. ` +
            `scratch-in rejections: ${topReasons(gen.rejectedReasonsByFamily["scratch-in"], 6)}. ` +
            `scratch-out rejections: ${topReasons(gen.rejectedReasonsByFamily["scratch-out"], 6)}.`,
        );
      }
      const thinFx = FX_KINDS.filter(
        (kind) => (gen.candidateCountsByFxKind[kind] ?? 0) === 0,
      );
      if (thinFx.length > 0) {
        lines.push("");
        lines.push(
          `- **fx kinds ${thinFx.join(", ")}** — 0 candidates. Fx dressings ride ` +
            `the standard blend (or the echo-out when no blend exists); their ` +
            `rejections are recorded against the host family: blend rejections ` +
            `include ${topReasons(gen.rejectedReasonsByFamily["blend"], 3)}.`,
        );
      }
    }
  }

  // Reachability
  lines.push("");
  lines.push("## Per-technique autonomous reachability (§0b)");
  lines.push("");
  const autonomousSession = inputs.sessions.find(
    (s) => s.configId === "autonomous",
  );
  lines.push(
    "Generated = candidates authored under autonomous (neutral) shaping across " +
      "all pair jobs. Drawn = joins carrying it in the autonomous brain run. " +
      "Performed = joins the performer performed with it across the autonomous " +
      "session simulations (performRecipe calls; no manual call in the loop). " +
      `Performed sample size is small by construction — the autonomous session ` +
      `sims performed ${autonomousSession?.performedJoins ?? 0} joins total ` +
      `(the 5 arcs' unique tracks bound the night) — so a performed-leg zero ` +
      `for a rarely-drawn row (e.g. drawn once in 2,466) is a sample-size ` +
      `fact first and an engine fact only where the drawn share is large.`,
  );
  lines.push("");
  lines.push("| Kind | Name | Generated | Drawn | Performed | Reachable |");
  lines.push("|---|---|---:|---:|---:|---|");
  for (const row of inputs.reachability) {
    lines.push(
      `| ${row.kind} | ${row.name} | ${row.generatedCandidates} | ${row.drawnJoins} | ${row.performedJoins} | ${row.reachable ? "yes" : "**NO**"} |`,
    );
  }
  const unreachable = inputs.reachability.filter((r) => !r.reachable);
  lines.push("");
  if (unreachable.length === 0) {
    lines.push("Every contract technique/move/effect clears all three legs.");
  } else {
    lines.push(
      "Unreachable or partially reachable rows: " +
        unreachable
          .map(
            (r) =>
              `${r.name} (generated ${r.generatedCandidates}, drawn ${r.drawnJoins}, performed ${r.performedJoins} — failing leg: ${
                r.generatedCandidates === 0
                  ? "generated"
                  : r.drawnJoins === 0
                    ? "drawn"
                    : "performed"
              })`,
          )
          .join("; ") +
        ".",
    );
  }
  lines.push("");
  return lines.join("\n");
}
