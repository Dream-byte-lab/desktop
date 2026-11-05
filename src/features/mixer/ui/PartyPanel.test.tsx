import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { useDjState } from "@/features/mixer/liverave/state";
import { usePlayerStore } from "@/features/player/store/playerStore";
import type {
  PartyInfo,
  PartyReaction,
  PartyRequestRecord,
  PartySearchReply,
  PartySearchRequest,
} from "../../../../electron/liverave/types";
import { PartyPanel, type PartyTransport } from "./PartyPanel";
import type { ProgrammeSearchSeam } from "./partySearchBridge";
import {
  fakeGuestRequest,
  makeFakeSession,
  makeTrack,
  type FakeSession,
} from "./fakeSession";

const JOIN_URL = "http://192.168.1.5:8471/#join=s3cret";

const RUNNING_INFO: PartyInfo = {
  running: true,
  port: 8471,
  joinSecret: "s3cret",
  addresses: [JOIN_URL],
};

const STOPPED_INFO: PartyInfo = {
  running: false,
  port: 0,
  joinSecret: "",
  addresses: [],
};

interface FakeTransport {
  transport: PartyTransport;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
  setRequestStatus: ReturnType<typeof vi.fn>;
  searchReply: ReturnType<typeof vi.fn>;
  searchUnsubscribe: ReturnType<typeof vi.fn>;
  fireRequest(record: PartyRequestRecord): void;
  fireReaction(reaction: PartyReaction): void;
  fireSearch(request: PartySearchRequest): void;
  hasSearchListener(): boolean;
}

function makeFakeTransport(initial: PartyInfo): FakeTransport {
  let info = initial;
  let requestCb: ((record: PartyRequestRecord) => void) | null = null;
  let reactionCb: ((reaction: PartyReaction) => void) | null = null;
  let searchCb: ((request: PartySearchRequest) => void) | null = null;
  const start = vi.fn(async () => {
    info = { ...RUNNING_INFO };
    return info;
  });
  const stop = vi.fn(async () => {
    info = { ...STOPPED_INFO };
    return info;
  });
  const setState = vi.fn();
  const setRequestStatus = vi.fn();
  const searchReply = vi.fn((_reply: PartySearchReply) => {});
  const searchUnsubscribe = vi.fn(() => {
    searchCb = null;
  });
  const transport: PartyTransport = {
    info: vi.fn(async () => info),
    start,
    stop,
    setState,
    setRequestStatus,
    onRequest: vi.fn((cb) => {
      requestCb = cb;
      return () => {
        requestCb = null;
      };
    }),
    onReaction: vi.fn((cb) => {
      reactionCb = cb;
      return () => {
        reactionCb = null;
      };
    }),
    onSearch: vi.fn((cb) => {
      searchCb = cb;
      return searchUnsubscribe;
    }),
    searchReply,
  };
  return {
    transport,
    start,
    stop,
    setState,
    setRequestStatus,
    searchReply,
    searchUnsubscribe,
    fireRequest: (record) => requestCb?.(record),
    fireReaction: (reaction) => reactionCb?.(reaction),
    fireSearch: (request) => searchCb?.(request),
    hasSearchListener: () => searchCb !== null,
  };
}

/** A hermetic programme seam: no search results, no by-id hits. */
function makeFakeSeam(
  overrides: Partial<ProgrammeSearchSeam> = {},
): ProgrammeSearchSeam & {
  searchTracks: ReturnType<typeof vi.fn>;
  getTrackById: ReturnType<typeof vi.fn>;
} {
  return {
    searchTracks: vi.fn(async () => []),
    getTrackById: vi.fn(async () => null),
    ...overrides,
  } as ProgrammeSearchSeam & {
    searchTracks: ReturnType<typeof vi.fn>;
    getTrackById: ReturnType<typeof vi.fn>;
  };
}

/** Lets pending bridge promises (search answers, resolutions) land. */
async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function resetStores(dj: { intent: boolean; active: boolean }) {
  const t1 = makeTrack("t1", "Song One");
  useDjState.setState({
    intent: dj.intent,
    active: dj.active,
    blending: false,
    proOpen: false,
    controlLevel: "autonomous",
  });
  usePlayerStore.setState({
    queue: [t1, makeTrack("t2", "Song Two"), makeTrack("t3", "Song Three")],
    currentIndex: 0,
    currentTrack: t1,
    status: "playing",
  });
}

describe("PartyPanel — the party surface on the landed seams", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  async function render(
    session: FakeSession,
    transport: PartyTransport | null,
    seam: ProgrammeSearchSeam = makeFakeSeam(),
  ) {
    await act(async () => {
      root.render(
        <PartyPanel
          session={session}
          transport={transport}
          searchSeam={seam}
        />,
      );
    });
  }

  it("renders nothing when DJ is off and no party is running — the app is untouched", async () => {
    resetStores({ intent: false, active: false });
    const fake = makeFakeTransport(STOPPED_INFO);
    await render(makeFakeSession(), fake.transport);
    expect(container.querySelector("[data-testid='party-panel']")).toBeNull();
    expect(
      container.querySelector("[data-testid='party-panel-strip']"),
    ).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("DJ off but a party is live: a slim strip keeps the End control reachable", async () => {
    resetStores({ intent: false, active: false });
    const fake = makeFakeTransport(RUNNING_INFO);
    await render(makeFakeSession(), fake.transport);
    const strip = container.querySelector("[data-testid='party-panel-strip']");
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("Party is live");
    expect(strip?.textContent).toContain(JOIN_URL);
    // The full programme is a DJ surface; it does not follow DJ off.
    expect(container.querySelector("[data-testid='party-panel']")).toBeNull();

    const endButton = strip?.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      endButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fake.stop).toHaveBeenCalledTimes(1);
    // Party ended + DJ off → the surface is gone entirely.
    expect(
      container.querySelector("[data-testid='party-panel-strip']"),
    ).toBeNull();
  });

  it("no party running: says so plainly, says how one starts, and starting works through the transport seam", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(STOPPED_INFO);
    await render(makeFakeSession(), fake.transport);
    const empty = container.querySelector("[data-party-empty]");
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain("No party is running");
    expect(container.querySelector("[data-party-status='off']")).not.toBeNull();

    const startButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Start a party"),
    );
    await act(async () => {
      startButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(fake.start).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector("[data-party-status='live']"),
    ).not.toBeNull();
    expect(container.querySelector("[data-party-invite]")).not.toBeNull();
  });

  it("no party bridge (not the desktop app): the absence is named and no start is offered", async () => {
    resetStores({ intent: true, active: true });
    await render(makeFakeSession(), null);
    expect(
      container.querySelector("[data-party-no-transport]")?.textContent,
    ).toContain("no party bridge");
    const startButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Start a party"),
    );
    expect(startButton).toBeUndefined();
  });

  it("live party, no requests: honest empty programme, invite QR + address, and no fake guest roster", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(RUNNING_INFO);
    await render(makeFakeSession(), fake.transport);

    const invite = container.querySelector("[data-party-invite]");
    expect(invite?.textContent).toContain(JOIN_URL);
    const qr = invite?.querySelector<HTMLImageElement>(
      'img[alt="QR code to join the party"]',
    );
    expect(qr).not.toBeNull();
    expect(qr?.src.startsWith("data:image/svg+xml")).toBe(true);

    const guests = container.querySelector("[data-party-guests]");
    expect(guests?.textContent).toContain("does not publish a guest list");
    expect(guests?.textContent).toContain("No reactions have arrived");

    expect(
      container.querySelector("[data-party-requests-empty]")?.textContent,
    ).toContain("No guest requests yet");
    expect(container.querySelector("[data-party-requests]")).toBeNull();
  });

  it("the programme is the session's own evaluation: scheduled / waiting / not-tonight with the brain's reasons verbatim", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(RUNNING_INFO);
    const t2 = makeTrack("t2", "Song Two");
    const t3 = makeTrack("t3", "Song Three");
    const t4 = makeTrack("t4", "Song Four");
    const t5 = makeTrack("t5", "Song Five");
    const session = makeFakeSession({
      partyRequests: [
        fakeGuestRequest({
          track: t3,
          status: "waiting",
          reason: "close, but not tonight's fit yet (fit 0.42)",
          votes: 2,
          voters: ["guest-a", "guest-b"],
        }),
        fakeGuestRequest({
          track: t2,
          status: "scheduled",
          reason: "fits tonight's arc (fit 0.81)",
          slot: 1,
          votes: 3,
          voters: ["guest-a", "guest-b", "guest-c"],
        }),
        fakeGuestRequest({
          track: t4,
          status: "not-tonight",
          reason: "already played tonight",
        }),
        fakeGuestRequest({
          track: t5,
          status: "not-tonight",
          reason: "on tonight's do-not-play list",
        }),
      ],
    });
    await render(session, fake.transport);

    // The not-tonight rows can only have come from evaluateRequests:
    // liveRaveOpenRequests excludes them by contract.
    expect(session.evaluateRequests).toHaveBeenCalled();
    const rows = [...container.querySelectorAll("[data-party-request]")];
    expect(rows.map((row) => row.getAttribute("data-party-request"))).toEqual([
      "scheduled",
      "waiting",
      "not-tonight",
      "not-tonight",
    ]);

    const [scheduled, waiting, played, blocked] = rows;
    expect(scheduled.textContent).toContain("Song Two");
    expect(scheduled.textContent).toContain("scheduled");
    expect(scheduled.textContent).toContain("3 guests asked");
    expect(scheduled.textContent).toContain("placed #2 in the upcoming order");
    expect(scheduled.textContent).toContain("fits tonight's arc (fit 0.81)");
    expect(scheduled.getAttribute("data-absolute")).toBeNull();

    expect(waiting.textContent).toContain("Song Three");
    expect(waiting.textContent).toContain("2 guests asked");
    expect(waiting.textContent).toContain(
      "close, but not tonight's fit yet (fit 0.42)",
    );

    // Absolute refusals read as absolute, with the session's reason.
    for (const [row, reason] of [
      [played, "already played tonight"],
      [blocked, "on tonight's do-not-play list"],
    ] as const) {
      expect(row.getAttribute("data-absolute")).toBe("true");
      expect(row.textContent).toContain(reason);
      expect(row.textContent).toContain("no override");
    }
  });

  it("re-weigh asks the session to evaluate again — the panel never re-decides a status itself", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(RUNNING_INFO);
    const session = makeFakeSession({
      partyRequests: [
        fakeGuestRequest({
          track: makeTrack("t2", "Song Two"),
          status: "waiting",
        }),
      ],
    });
    await render(session, fake.transport);
    const before = session.evaluateRequests.mock.calls.length;
    const button = container.querySelector<HTMLButtonElement>(
      "[data-party-reweigh]",
    );
    await act(async () => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(session.evaluateRequests.mock.calls.length).toBeGreaterThan(before);
  });

  it("publishes tonight's public state to the guests: catalogue, now playing, scheduled guests flagged in up-next", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(RUNNING_INFO);
    const session = makeFakeSession({
      partyRequests: [
        fakeGuestRequest({
          track: makeTrack("t3", "Song Three"),
          status: "scheduled",
          reason: "fits tonight's arc (fit 0.81)",
          slot: 0,
        }),
      ],
    });
    await render(session, fake.transport);
    expect(fake.setState).toHaveBeenCalled();
    const published = fake.setState.mock.calls.at(-1)?.[0];
    expect(published.open).toBe(true);
    expect(published.nowPlaying?.id).toBe("t1");
    expect(published.catalogue.map((t: { id: string }) => t.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
    const upNextThree = published.upNext.find(
      (t: { id: string }) => t.id === "t3",
    );
    expect(upNextThree?.requested).toBe(true);
    const upNextTwo = published.upNext.find(
      (t: { id: string }) => t.id === "t2",
    );
    expect(upNextTwo?.requested).toBeUndefined();
  });

  it("guest arrivals are fed to the session by queue track and the verdict is relayed back in the transport's words", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(RUNNING_INFO);
    const session = makeFakeSession({
      partyRequests: [
        fakeGuestRequest({
          track: makeTrack("t3", "Song Three"),
          status: "scheduled",
          reason: "fits tonight's arc (fit 0.81)",
          slot: 0,
        }),
      ],
    });
    await render(session, fake.transport);

    await act(async () => {
      fake.fireRequest({
        requestId: "req-1",
        guestToken: "token-a",
        trackId: "t3",
        source: "tonight",
        requestedAtSec: 42,
        status: "received",
      });
    });
    expect(session.submitGuestRequest).toHaveBeenCalledTimes(1);
    const [submittedTrack, submittedGuest] =
      session.submitGuestRequest.mock.calls[0];
    expect(submittedTrack.id).toBe("t3");
    expect(submittedGuest).toBe("token-a");
    expect(fake.setRequestStatus).toHaveBeenCalledWith({
      requestId: "req-1",
      status: "coming soon",
    });
    // The token is plumbing for the seam, never display material.
    expect(container.textContent).not.toContain("token-a");
  });

  it("an arrival no pool can resolve is counted and named, never silently dropped or judged", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(RUNNING_INFO);
    const session = makeFakeSession();
    const seam = makeFakeSeam();
    await render(session, fake.transport, seam);

    await act(async () => {
      fake.fireRequest({
        requestId: "req-9",
        guestToken: "token-z",
        trackId: "not-in-queue",
        source: "search",
        requestedAtSec: 7,
        status: "received",
      });
    });
    await flushAsync();
    // The by-id pool was honestly tried before the arrival was
    // counted: queue miss → search-cache miss → catalogue miss.
    expect(seam.getTrackById).toHaveBeenCalledWith("not-in-queue");
    expect(session.submitGuestRequest).not.toHaveBeenCalled();
    const note = container.querySelector("[data-party-unresolved]");
    expect(note?.textContent).toContain("could not be resolved tonight");
    expect(note?.textContent).toContain("stay unweighed");
  });

  it("guest programme searches are answered through the bridge in the transport's own shape", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(RUNNING_INFO);
    const seam = makeFakeSeam({
      searchTracks: vi.fn(async () => [makeTrack("x1", "Far Song")]),
    });
    await render(makeFakeSession(), fake.transport, seam);
    expect(fake.hasSearchListener()).toBe(true);

    fake.fireSearch({ searchId: "s1", query: "far" });
    await flushAsync();
    expect(seam.searchTracks).toHaveBeenCalledWith("far");
    expect(fake.searchReply).toHaveBeenCalledWith({
      searchId: "s1",
      tracks: [
        {
          id: "x1",
          title: "Far Song",
          artist: "Test Artist",
          source: "search",
        },
      ],
    });

    // A malformed ask still gets its honest empty reply.
    fake.fireSearch({ searchId: "s2", query: " " });
    await flushAsync();
    expect(fake.searchReply).toHaveBeenCalledWith({
      searchId: "s2",
      tracks: [],
    });
  });

  it("the bridge is inert when no party is live, and ending the party unsubscribes it", async () => {
    resetStores({ intent: true, active: true });
    const stopped = makeFakeTransport(STOPPED_INFO);
    const seam = makeFakeSeam({
      searchTracks: vi.fn(async () => [makeTrack("x1", "Far Song")]),
    });
    await render(makeFakeSession(), stopped.transport, seam);
    expect(stopped.hasSearchListener()).toBe(false);
    stopped.fireSearch({ searchId: "s0", query: "far" });
    await flushAsync();
    expect(stopped.searchReply).not.toHaveBeenCalled();
    expect(seam.searchTracks).not.toHaveBeenCalled();

    // Live party: subscribed. End party: unsubscribed, and later
    // searches go unanswered — no leaked subscription.
    const live = makeFakeTransport(RUNNING_INFO);
    await render(makeFakeSession(), live.transport, seam);
    expect(live.hasSearchListener()).toBe(true);
    const endButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("End party"),
    );
    await act(async () => {
      endButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(live.searchUnsubscribe).toHaveBeenCalled();
    expect(live.hasSearchListener()).toBe(false);
    live.fireSearch({ searchId: "s9", query: "far" });
    await flushAsync();
    expect(live.searchReply).not.toHaveBeenCalled();
  });

  it("an out-of-queue arrival surfaced by tonight's search resolves from the cache and is weighed like any arrival", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(RUNNING_INFO);
    const session = makeFakeSession();
    const seam = makeFakeSeam({
      searchTracks: vi.fn(async () => [makeTrack("x1", "Far Song")]),
    });
    await render(session, fake.transport, seam);

    fake.fireSearch({ searchId: "s1", query: "far" });
    await flushAsync();
    await act(async () => {
      fake.fireRequest({
        requestId: "req-x1",
        guestToken: "token-a",
        trackId: "x1",
        source: "search",
        requestedAtSec: 9,
        status: "received",
      });
    });
    await flushAsync();
    expect(seam.getTrackById).not.toHaveBeenCalled();
    expect(session.submitGuestRequest).toHaveBeenCalledTimes(1);
    const [submittedTrack, submittedGuest] =
      session.submitGuestRequest.mock.calls[0];
    expect(submittedTrack.id).toBe("x1");
    expect(submittedTrack.title).toBe("Far Song");
    expect(submittedGuest).toBe("token-a");
    // Weighed by the session like any arrival: the fake session's
    // verdict (waiting) is relayed back in the transport's words.
    expect(fake.setRequestStatus).toHaveBeenCalledWith({
      requestId: "req-x1",
      status: "waiting for its moment",
    });
    expect(container.querySelector("[data-party-unresolved]")).toBeNull();
  });

  it("an out-of-queue arrival the cache missed still resolves by id through the catalogue", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(RUNNING_INFO);
    const session = makeFakeSession();
    const seam = makeFakeSeam({
      getTrackById: vi.fn(async (id: string) =>
        id === "x9" ? makeTrack("x9", "Looked Up") : null,
      ),
    });
    await render(session, fake.transport, seam);

    await act(async () => {
      fake.fireRequest({
        requestId: "req-x9",
        guestToken: "token-b",
        trackId: "x9",
        source: "search",
        requestedAtSec: 11,
        status: "received",
      });
    });
    await flushAsync();
    expect(seam.getTrackById).toHaveBeenCalledWith("x9");
    expect(session.submitGuestRequest).toHaveBeenCalledTimes(1);
    expect(session.submitGuestRequest.mock.calls[0][0].title).toBe("Looked Up");
    expect(fake.setRequestStatus).toHaveBeenCalledWith({
      requestId: "req-x9",
      status: "waiting for its moment",
    });
    expect(container.querySelector("[data-party-unresolved]")).toBeNull();
  });

  it("reactions are tallied as they arrive while the panel is open", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(RUNNING_INFO);
    await render(makeFakeSession(), fake.transport);
    await act(async () => {
      fake.fireReaction({ guestToken: "token-a", kind: "fire", atMs: 1 });
      fake.fireReaction({ guestToken: "token-b", kind: "fire", atMs: 2 });
      fake.fireReaction({ guestToken: "token-a", kind: "heart", atMs: 3 });
    });
    const tally = container.querySelector("[data-party-reactions]");
    expect(tally?.textContent).toContain("fire 2");
    expect(tally?.textContent).toContain("heart 1");
  });

  it("party live but the set is not running: requests rest on the open book and the panel says verdicts wait for a set", async () => {
    resetStores({ intent: true, active: false });
    const fake = makeFakeTransport(RUNNING_INFO);
    const session = makeFakeSession({
      sessionRunning: false,
      partyRequests: [
        fakeGuestRequest({
          track: makeTrack("t2", "Song Two"),
          status: "waiting",
          reason: "waiting for tonight's fit",
        }),
      ],
    });
    await render(session, fake.transport);
    const programme = container.querySelector("[data-party-programme]");
    expect(programme?.textContent).toContain("The DJ set is not running");
    expect(programme?.textContent).toContain("Song Two");
    // Without a running set the panel does not ask for an evaluation.
    expect(session.evaluateRequests).not.toHaveBeenCalled();
  });

  it("do-not-play: the one host override the seam exposes, applied through setDoNotPlay and shown as blocked here", async () => {
    resetStores({ intent: true, active: true });
    const fake = makeFakeTransport(RUNNING_INFO);
    const blockTrack = makeTrack("blockme", "Block Me");
    usePlayerStore.setState({
      queue: [makeTrack("t1", "Song One"), blockTrack],
    });
    const session = makeFakeSession({
      partyRequests: [
        fakeGuestRequest({
          track: blockTrack,
          status: "waiting",
          reason: "close, but not tonight's fit yet (fit 0.42)",
        }),
      ],
    });
    await render(session, fake.transport);

    const blockButton = container.querySelector<HTMLButtonElement>(
      "[data-party-block='blockme']",
    );
    await act(async () => {
      blockButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(session.setDoNotPlay).toHaveBeenCalled();
    const applied = session.setDoNotPlay.mock.calls.at(-1)?.[0];
    expect([...(applied as Iterable<string>)]).toContain("blockme");

    const blockedZone = container.querySelector("[data-party-blocked]");
    expect(blockedZone?.textContent).toContain("Block Me");
    expect(blockedZone?.textContent).toContain("does not publish");

    const unblock = container.querySelector<HTMLButtonElement>(
      "[data-party-unblock='blockme']",
    );
    await act(async () => {
      unblock!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const afterUnblock = session.setDoNotPlay.mock.calls.at(-1)?.[0];
    expect([...(afterUnblock as Iterable<string>)]).not.toContain("blockme");
    expect(container.querySelector("[data-party-blocked]")).toBeNull();
  });

  // -- dismissal (fix-0119) --------------------------------------

  function hideButton(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(
      "button[aria-label='Hide party panel']",
    );
  }

  it("the panel can be hidden for the current intent-on period, and returns when intent cycles off→on (fix-0119)", async () => {
    resetStores({ intent: true, active: false });
    const fake = makeFakeTransport(STOPPED_INFO);
    await render(makeFakeSession(), fake.transport);
    expect(
      container.querySelector("[data-testid='party-panel']"),
    ).not.toBeNull();
    // Start is reachable before the dismiss (never trapped by it).
    const startButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Start a party"),
    );
    expect(startButton).not.toBeUndefined();

    await act(async () => {
      hideButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("[data-testid='party-panel']")).toBeNull();

    // Intent off ends the period; intent on again shows it.
    act(() => {
      useDjState.setState({ intent: false });
    });
    expect(container.querySelector("[data-testid='party-panel']")).toBeNull();
    act(() => {
      useDjState.setState({ intent: true });
    });
    expect(
      container.querySelector("[data-testid='party-panel']"),
    ).not.toBeNull();
  });

  it("a live party overrides the dismissal, and ending it returns the panel — End is never trapped (fix-0119)", async () => {
    resetStores({ intent: true, active: false });
    const stopped = makeFakeTransport(STOPPED_INFO);
    const session = makeFakeSession();
    await render(session, stopped.transport);
    await act(async () => {
      hideButton()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("[data-testid='party-panel']")).toBeNull();

    // The party starts (transport seam now reports it live): the
    // panel is back with its End control, dismissal or not.
    const live = makeFakeTransport(RUNNING_INFO);
    await render(session, live.transport);
    expect(
      container.querySelector("[data-testid='party-panel']"),
    ).not.toBeNull();
    const endButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("End party"),
    );
    expect(endButton).not.toBeUndefined();

    // Ending the party returns the ordinary panel — the start of
    // the party reset the dismissal rather than stranding the
    // host with no panel at all.
    await act(async () => {
      endButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(live.stop).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-party-empty]")).not.toBeNull();
  });
});
