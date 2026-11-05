// fakeSession.ts — a hand-built fake LiveRaveSession for the new
// surfaces' behaviour tests. It implements exactly the seams the
// Ribbon, Booth and ON AIR pill read (stageSnapshot,
// nextJoinPreview, setArc, getBehaviourLog, activityFeed, the
// transport, triggerDeckMove, curateRemaining, setControlLevel),
// with data a test can shape per case. Test support only — no
// production surface imports this file.

import { vi, type Mock } from "vitest";
import type {
  ActivityEvent,
  ControlLevel,
  CurateResult,
  DeckMoveRequest,
  DeckMoveResult,
  LiveRaveSession,
  NextJoinPreview,
  SessionEndReason,
  StageDeckFactsSummary,
} from "@/features/mixer/liverave/session";
import type { BehaviourRecord } from "@/features/mixer/liverave/memory";
import type {
  GuestRequest,
  GuestRequestStatus,
} from "@/features/mixer/liverave/party";
import type { Track } from "@/shared/types";

export function makeTrack(id: string, title: string): Track {
  return {
    id,
    title,
    artists: "Test Artist",
    coverUrl: "",
    durationMs: 200_000,
    playCount: 0,
  } as Track;
}

export const FAKE_EVIDENCE = {
  tempoFit: 0.9,
  keyFit: 0.8,
  phraseFit: 0.7,
  structureFit: 0.6,
  energyFit: 0.5,
  vocalSafety: 0.95,
};

export function fakeRecipe(overrides: Record<string, unknown> = {}) {
  return {
    id: "recipe-1",
    family: "scratch-in",
    technique: "flare",
    outgoing: {
      trackId: "t1",
      audioHash: null,
      exitAnchorMs: 1000,
      exitBeat: 8,
    },
    incoming: {
      trackId: "t2",
      audioHash: null,
      entryAnchorMs: 0,
      entryBeat: 0,
    },
    overlapBeats: 16,
    rates: { rateA: 1, rateB: 1, beatmatched: true },
    curves: {
      gainA: [
        { atBeat: 0, value: 1 },
        { atBeat: 16, value: 0 },
      ],
      gainB: [
        { atBeat: 0, value: 0 },
        { atBeat: 16, value: 1 },
      ],
      eqA: { low: [], mid: [], high: [] },
      eqB: { low: [], mid: [], high: [] },
      filterA: [],
      filterB: [],
    },
    blocks: [],
    authored: { evidence: { ...FAKE_EVIDENCE }, notes: [] },
    ...overrides,
  };
}

export function fakePreview(): NextJoinPreview {
  const recipe = fakeRecipe();
  return {
    trackId: "t2",
    trackTitle: "Song Two",
    family: "scratch-in",
    technique: "flare",
    suitability: 0.82,
    poolSize: 2,
    pool: [
      {
        trackId: "t2",
        family: "scratch-in",
        technique: "flare",
        fxKinds: [],
        suitability: 0.82,
        evidence: { ...FAKE_EVIDENCE },
      },
      {
        trackId: "t3",
        family: "blend",
        fxKinds: [],
        suitability: 0.61,
        evidence: { tempoFit: 0.7, keyFit: 0.66, vocalSafety: 0.9 },
      },
    ],
    recipe: recipe as NextJoinPreview["recipe"],
  };
}

/** Deck A by default: a full facts summary, as the session builds it. */
export function fakeDeckFacts(
  overrides: Partial<StageDeckFactsSummary> = {},
): StageDeckFactsSummary {
  return {
    bpm: 124,
    keyCamelot: "8A",
    beatmatchTrusted: true,
    energyNow: 0.42,
    energyContour: [
      { atMs: 0, rms: 0.2 },
      { atMs: 10_000, rms: 0.42 },
      { atMs: 20_000, rms: 0.65 },
      { atMs: 30_000, rms: 0.3 },
    ],
    ...overrides,
  };
}

export function fakeBehaviour(): BehaviourRecord[] {
  return [
    {
      at: 1_700_000_000_000,
      family: "blend",
      fxKinds: [],
      pairTrackIds: ["t0", "t1"],
      suitability: 0.77,
      poolSize: 4,
      reason: "performed",
    },
    {
      at: 1_700_000_060_000,
      family: null,
      fxKinds: [],
      pairTrackIds: ["t1", "t2"],
      suitability: null,
      poolSize: 0,
      reason: "fallback-unprepared",
    },
  ];
}

export function fakeActivity(): ActivityEvent[] {
  return [
    {
      at: 1_700_000_000_000,
      kind: "started",
      text: 'Set started with "Song One"',
    },
    {
      at: 1_700_000_030_000,
      kind: "drawn",
      text: 'Drew scratch-in (flare) into "Song Two" — suitability 0.82, pool of 2',
    },
    {
      at: 1_700_000_060_000,
      kind: "fallback",
      text: 'Plain cut into "Song Two" — fallback-unprepared',
      reason: "fallback-unprepared",
    },
  ];
}

export interface FakeSession extends LiveRaveSession {
  skipNext: Mock<() => void>;
  skipPrevious: Mock<() => void>;
  pause: Mock<() => void>;
  resume: Mock<() => void>;
  stop: Mock<(reason?: SessionEndReason) => void>;
  triggerDeckMove: Mock<(request: DeckMoveRequest) => Promise<DeckMoveResult>>;
  curateRemaining: Mock<() => Promise<CurateResult>>;
  setControlLevel: Mock<(level: ControlLevel) => void>;
  submitGuestRequest: Mock<(track: Track, guestId?: string) => GuestRequest>;
  evaluateRequests: Mock<() => GuestRequest[]>;
  guestStatus: Mock<(trackId: string) => GuestRequestStatus | null>;
  setDoNotPlay: Mock<(trackIds: Iterable<string>) => void>;
}

/** A guest request in the party seam's own shape, for panel tests. */
export function fakeGuestRequest(
  overrides: Partial<GuestRequest> & { track: Track },
): GuestRequest {
  return {
    id: `guest-request-${overrides.track.id}`,
    guestId: "guest-a",
    voters: ["guest-a"],
    votes: 1,
    status: "waiting",
    reason: "waiting for tonight's fit",
    slot: null,
    requestedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeFakeSession(
  overrides: Partial<{
    /** The start attempt's visible state (fix-0119 seams). */
    startState: "idle" | "starting" | "ready" | "failed";
    startFailure: string | null;
    preparing: boolean;
    blending: boolean;
    currentMove: {
      label: string;
      family: string | null;
      technique: string | null;
    } | null;
    preview: NextJoinPreview | null;
    deckMoveResult: unknown;
    curateResult: unknown;
    /** The session's party book, in the party seam's own shape. */
    partyRequests: GuestRequest[];
    sessionRunning: boolean;
    /** [deck A facts, deck B facts]; default: A present, B null. */
    deckFacts: [StageDeckFactsSummary | null, StageDeckFactsSummary | null];
  }> = {},
): FakeSession {
  const partyRequests: GuestRequest[] = (overrides.partyRequests ?? []).map(
    (request) => ({ ...request, voters: [...request.voters] }),
  );
  const copyRequests = (): GuestRequest[] =>
    partyRequests.map((request) => ({
      ...request,
      voters: [...request.voters],
    }));
  const activity = fakeActivity();
  const preview =
    overrides.preview === undefined ? fakePreview() : overrides.preview;
  const currentMove =
    overrides.currentMove === undefined
      ? {
          label: "scratch-in into Song Two",
          family: "scratch-in",
          technique: "flare",
        }
      : overrides.currentMove;

  const fake = {
    isRunning: overrides.sessionRunning ?? true,
    isPaused: false,
    endReason: null,
    startState: overrides.startState ?? "ready",
    startFailure: overrides.startFailure ?? null,
    preparing: overrides.preparing ?? false,
    degraded: true,
    fallbackCount: 1,
    blending: overrides.blending ?? true,
    controlLevel: "autonomous",
    get liveRaveOpenRequests(): GuestRequest[] {
      // The real seam's contract: scheduled or waiting only —
      // not-tonight requests are NOT open.
      return copyRequests().filter(
        (request) =>
          request.status === "scheduled" || request.status === "waiting",
      );
    },
    nextJoinPreview: preview,
    activityFeed: {
      subscribe: (_listener: (event: ActivityEvent) => void) => () => {},
      events: () => [...activity],
      latest: () => activity[activity.length - 1] ?? null,
    },
    onRunningChange: null,
    onBlendingChange: null,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    skipNext: vi.fn(),
    skipPrevious: vi.fn(),
    seekTo: vi.fn(),
    setShaping: vi.fn(),
    setControlLevel: vi.fn(),
    stageSnapshot: () => ({
      decks: [
        {
          trackId: "t1",
          positionMs: 30_000,
          positionSec: 30,
          playing: true,
          rate: 1,
          facts:
            overrides.deckFacts === undefined
              ? fakeDeckFacts()
              : overrides.deckFacts[0],
        },
        {
          trackId: "t2",
          positionMs: 0,
          positionSec: 0,
          playing: false,
          rate: 1,
          facts:
            overrides.deckFacts === undefined ? null : overrides.deckFacts[1],
        },
      ] as const,
      currentMove,
      controlLevel: "autonomous" as const,
    }),
    masterAnalyser: () => null,
    curateRemaining: vi.fn(async () => overrides.curateResult ?? { ok: true }),
    triggerDeckMove: vi.fn(
      async () =>
        overrides.deckMoveResult ?? { ok: false, reason: "join-locked" },
    ),
    setArc: () => ({ played: [0.4, 0.7], upcoming: [0.9, 0.55] }),
    getBehaviourLog: () => fakeBehaviour(),
    submitGuestRequest: vi.fn((track: Track, guestId = "guest") => {
      const existing = partyRequests.find((r) => r.track.id === track.id);
      if (existing) return { ...existing, voters: [...existing.voters] };
      const request: GuestRequest = {
        id: `guest-request-${partyRequests.length + 1}`,
        track,
        guestId,
        voters: [guestId],
        votes: 1,
        status: "waiting",
        reason: "waiting for tonight's fit",
        slot: null,
        requestedAt: 1_700_000_000_000,
      };
      partyRequests.push(request);
      return { ...request, voters: [...request.voters] };
    }),
    evaluateRequests: vi.fn(() => copyRequests()),
    guestStatus: vi.fn(
      (trackId: string) =>
        partyRequests.find((r) => r.track.id === trackId)?.status ?? null,
    ),
    setDoNotPlay: vi.fn(),
  };
  return fake as unknown as FakeSession;
}
