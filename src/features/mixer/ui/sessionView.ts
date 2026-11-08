// sessionView.ts — the shared read model for the new DJ surfaces.
//
// The session (liverave/session.ts) is deliberately not a reactive
// store: it exposes pull seams (stageSnapshot, nextJoinPreview,
// setArc, getBehaviourLog) and one push seam (activityFeed). This
// module turns those into a React view that re-reads on a musical
// cadence (500 ms) and immediately on every narration event, and
// carries the plain-language label tables the Ribbon and the Booth
// share (evidence names, technique names, personality colours,
// slider captions). Everything displayed by the surfaces comes
// through here or directly off the session — nothing is invented:
// where the session exposes no data for an element, the surfaces
// render the absence and this module says so in its comments.

import { useEffect, useState } from "react";
import type {
  ActivityEvent,
  LiveRaveSession,
  NextJoinPreview,
  SessionStageSnapshot,
  SessionStartState,
} from "@/features/mixer/liverave/session";
import type { BehaviourRecord } from "@/features/mixer/liverave/memory";
import type {
  PersonalityId,
  SliderId,
} from "@/features/mixer/liverave/shaping";

export interface SessionView {
  running: boolean;
  snapshot: SessionStageSnapshot | null;
  preview: NextJoinPreview | null;
  arc: { played: number[]; upcoming: number[] };
  behaviour: BehaviourRecord[];
  activity: ActivityEvent[];
  /**
   * The start attempt's visible state (fix-0119): surfaces show
   * "starting" while the preparing phase runs and, on "failed",
   * the engine's own recorded failure reason — never invented
   * text, never silence.
   */
  startState: SessionStartState;
  startFailure: string | null;
  preparing: boolean;
}

const EMPTY_VIEW: SessionView = {
  running: false,
  snapshot: null,
  preview: null,
  arc: { played: [], upcoming: [] },
  behaviour: [],
  activity: [],
  startState: "idle",
  startFailure: null,
  preparing: false,
};

function readView(session: LiveRaveSession): SessionView {
  try {
    return {
      running: session.isRunning,
      snapshot: session.stageSnapshot(),
      preview: session.nextJoinPreview,
      arc: session.setArc(),
      behaviour: session.getBehaviourLog(),
      activity: session.activityFeed.events(),
      startState: session.startState ?? "idle",
      startFailure: session.startFailure ?? null,
      preparing: session.preparing ?? false,
    };
  } catch {
    // A session mid-teardown must not take the surface down with it.
    return EMPTY_VIEW;
  }
}

/**
 * Live view of a session: re-reads the pull seams every 500 ms and
 * on every activity-feed event (the feed is the session's own
 * narration, so a new event is exactly when the view changes).
 */
export function useSessionView(
  session: LiveRaveSession,
  enabled: boolean,
): SessionView {
  const [view, setView] = useState<SessionView>(() =>
    enabled ? readView(session) : EMPTY_VIEW,
  );

  useEffect(() => {
    if (!enabled) {
      setView(EMPTY_VIEW);
      return;
    }
    setView(readView(session));
    const unsubscribe = session.activityFeed.subscribe(() => {
      setView(readView(session));
    });
    const timer = setInterval(() => setView(readView(session)), 500);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [session, enabled]);

  return view;
}

// ---------------------------------------------------------------------
// Plain-language labels (the technique vocabulary is recipe.ts's;
// the evidence vocabulary is brain.ts's published components)
// ---------------------------------------------------------------------

/** "FLARE SCRATCH" / "LOOP BLEND" — the move named in large type. */
export function moveLabel(
  family: string | null,
  technique?: string | null,
): string {
  if (!family)
    return technique ? technique.replace(/-/g, " ").toUpperCase() : "";
  if (technique && (family === "scratch-in" || family === "scratch-out")) {
    return `${technique.replace(/-/g, " ").toUpperCase()} SCRATCH`;
  }
  const base = family.replace(/-/g, " ").toUpperCase();
  return technique
    ? `${base} · ${technique.replace(/-/g, " ").toUpperCase()}`
    : base;
}

export const EVIDENCE_LABELS: Record<string, string> = {
  tempoFit: "Tempo fit",
  keyFit: "Key fit",
  phraseFit: "Phrase fit",
  structureFit: "Structure fit",
  energyFit: "Energy fit",
  vocalSafety: "Vocal safety",
};

/** Evidence components of a candidate as named, honest chips. */
export function evidenceChips(
  evidence: Record<string, number> | undefined,
): { key: string; label: string; value: number }[] {
  if (!evidence) return [];
  return Object.entries(evidence)
    .filter(([, v]) => typeof v === "number" && Number.isFinite(v))
    .map(([key, value]) => ({
      key,
      label: EVIDENCE_LABELS[key] ?? key,
      value,
    }))
    .sort((a, z) => z.value - a.value);
}

// ---------------------------------------------------------------------
// Behaviour distribution — counted here from the session's records
// (the same counting memory.ts's distribution() performs; the
// session seam exposes the records, so the surfaces count them).
// ---------------------------------------------------------------------

export interface BehaviourDistributionView {
  total: number;
  byFamily: Record<string, number>;
  byTechnique: Record<string, number>;
  byReason: Record<string, number>;
}

export function distributionOf(
  records: BehaviourRecord[],
): BehaviourDistributionView {
  const byFamily: Record<string, number> = {};
  const byTechnique: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  for (const record of records) {
    const familyKey = record.family ?? "none";
    byFamily[familyKey] = (byFamily[familyKey] ?? 0) + 1;
    if (record.technique !== undefined) {
      byTechnique[record.technique] = (byTechnique[record.technique] ?? 0) + 1;
    }
    byReason[record.reason] = (byReason[record.reason] ?? 0) + 1;
  }
  return { total: records.length, byFamily, byTechnique, byReason };
}

export function isFallbackReason(reason: string): boolean {
  return reason === "fallback-unprepared" || reason === "fallback-invalid";
}

/**
 * The receipts stamp as one short line (wave item 4): who chose
 * this join, where it sat on the slate, which ladder rung landed
 * it, and the crates table version in force — e.g.
 * "planner · slate #2 · rung 1 · crates-v1". Records written
 * before the wave carry no stamp and render nothing.
 */
export function provenanceLabel(
  record: Pick<BehaviourRecord, "provenance">,
): string {
  const stamp = record.provenance;
  if (!stamp) return "";
  const parts: string[] = [stamp.source];
  if (stamp.slatePosition !== null) parts.push(`slate #${stamp.slatePosition}`);
  if (stamp.ladderRung !== null) parts.push(`rung ${stamp.ladderRung}`);
  if (stamp.cratesVersion !== null) parts.push(stamp.cratesVersion);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------
// Personalities (§10.3 tiles) — signature colour + one-line behaviour
// from PERSONALITY-TARGETS as summarised in shaping.ts's own header.
// ---------------------------------------------------------------------

export interface PersonalityMeta {
  id: PersonalityId;
  name: string;
  colour: string;
  line: string;
}

export const PERSONALITIES: PersonalityMeta[] = [
  {
    id: "autonomous",
    name: "Autonomous",
    colour: "#d9d9e0",
    line: "The un-personalised DJ — every move on the pair's evidence alone.",
  },
  {
    id: "club",
    name: "Club",
    colour: "#ff3d81",
    line: "Longer blends, drops, EQ work and effects — peak-time energy.",
  },
  {
    id: "battle",
    name: "Battle",
    colour: "#ff6a2a",
    line: "Scratching, cuts and stops — hands busy, theatre up front.",
  },
  {
    id: "house",
    name: "House",
    colour: "#ffb300",
    line: "Extended gradual blends and groove continuity, theatre kept low.",
  },
  {
    id: "open-format",
    name: "Open Format",
    colour: "#00bfa5",
    line: "Wide genre flexibility, balanced moves across the whole night.",
  },
  {
    id: "experimental",
    name: "Experimental",
    colour: "#8b6cff",
    line: "Unusual joins, fx chains and wide key/tempo tolerance.",
  },
  {
    id: "radio",
    name: "Radio",
    colour: "#42a5f5",
    line: "Smooth and consistent — theatre present, but rare.",
  },
];

export function personalityColour(id: PersonalityId): string {
  return PERSONALITIES.find((p) => p.id === id)?.colour ?? "#d9d9e0";
}

// ---------------------------------------------------------------------
// Sliders (§10.3 strips) — plain captions + the live-effect wording.
// ---------------------------------------------------------------------

export interface SliderMeta {
  id: SliderId;
  name: string;
  caption: string;
  low: string;
  high: string;
}

export const SLIDERS: SliderMeta[] = [
  {
    id: "intensity",
    name: "Intensity",
    caption: "How hard the DJ pushes drops, stops and scratches",
    low: "calmer, smoother",
    high: "theatre-leaning",
  },
  {
    id: "creativity",
    name: "Creativity",
    caption: "How constructed and unusual the joins get",
    low: "classic joins",
    high: "unusual joins",
  },
  {
    id: "scratching",
    name: "Scratching",
    caption: "How much turntable work the set carries",
    low: "rarely scratched",
    high: "battle-leaning",
  },
  {
    id: "effects",
    name: "Effects",
    caption: "How much fx dressing rides on the joins",
    low: "mostly dry",
    high: "washed in fx",
  },
  {
    id: "transitionComplexity",
    name: "Transition complexity",
    caption: "How layered each join is built",
    low: "clean and simple",
    high: "layered joins",
  },
  {
    id: "genreFlexibility",
    name: "Genre flexibility",
    caption: "How far across genres the next pick may reach",
    low: "stays in genre",
    high: "wide-ranging",
  },
  {
    id: "energyProgression",
    name: "Energy progression",
    caption: "How steeply the set's energy arc climbs",
    low: "steady energy",
    high: "big climbs",
  },
  {
    id: "trackSelectionFreedom",
    name: "Track-selection freedom",
    caption: "How freely the DJ roams the playlist for the next track",
    low: "safest next tracks",
    high: "free-ranging picks",
  },
];

/** The slider's live effect in plain words ("scratching: battle-leaning"). */
export function sliderEffect(meta: SliderMeta, value: number): string {
  if (value <= 0.35) return `${meta.name.toLowerCase()}: ${meta.low}`;
  if (value >= 0.65) return `${meta.name.toLowerCase()}: ${meta.high}`;
  return `${meta.name.toLowerCase()}: neutral`;
}

export function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, "0")}`;
}

export function formatTimeOfDay(at: number): string {
  try {
    return new Date(at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}
