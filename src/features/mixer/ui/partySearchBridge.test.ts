import { describe, expect, it, vi } from "vitest";
import type {
  PartySearchReply,
  PartySearchRequest,
} from "../../../../electron/liverave/types";
import {
  createPartySearchBridge,
  type PartySearchTransport,
  type ProgrammeSearchSeam,
} from "./partySearchBridge";
import { makeTrack } from "./fakeSession";

interface FakeSearchTransport {
  transport: PartySearchTransport;
  searchReply: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  fireSearch(request: PartySearchRequest): void;
  hasListener(): boolean;
}

function makeFakeSearchTransport(): FakeSearchTransport {
  let cb: ((request: PartySearchRequest) => void) | null = null;
  const searchReply = vi.fn((_reply: PartySearchReply) => {});
  const unsubscribe = vi.fn(() => {
    cb = null;
  });
  return {
    transport: {
      onSearch: vi.fn((handler) => {
        cb = handler;
        return unsubscribe;
      }),
      searchReply,
    },
    searchReply,
    unsubscribe,
    fireSearch: (request) => cb?.(request),
    hasListener: () => cb !== null,
  };
}

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

/** Lets the bridge's async search handling settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("partySearchBridge — guest searches answered from the programme seam", () => {
  it("answers a guest search with shaped, source-stamped listings", async () => {
    const fake = makeFakeSearchTransport();
    const seam = makeFakeSeam({
      searchTracks: vi.fn(async () => [
        makeTrack("x1", "Far Song"),
        makeTrack("x2", "Farther Song"),
      ]),
    });
    const bridge = createPartySearchBridge({
      transport: fake.transport,
      seam,
    });
    bridge.attach();
    fake.fireSearch({ searchId: "s1", query: "far" });
    await flush();
    expect(seam.searchTracks).toHaveBeenCalledWith("far");
    expect(fake.searchReply).toHaveBeenCalledTimes(1);
    expect(fake.searchReply).toHaveBeenCalledWith({
      searchId: "s1",
      tracks: [
        {
          id: "x1",
          title: "Far Song",
          artist: "Test Artist",
          source: "search",
        },
        {
          id: "x2",
          title: "Farther Song",
          artist: "Test Artist",
          source: "search",
        },
      ],
    });
  });

  it("empty and malformed queries get an honest empty reply, never a hang, and never reach the seam", async () => {
    const fake = makeFakeSearchTransport();
    const seam = makeFakeSeam();
    const bridge = createPartySearchBridge({
      transport: fake.transport,
      seam,
    });
    bridge.attach();
    fake.fireSearch({ searchId: "s-empty", query: "" });
    fake.fireSearch({ searchId: "s-blank", query: "   " });
    fake.fireSearch({ searchId: "s-one", query: "a" });
    fake.fireSearch({
      searchId: "s-nonstr",
      query: 42 as unknown as string,
    });
    await flush();
    expect(seam.searchTracks).not.toHaveBeenCalled();
    expect(fake.searchReply).toHaveBeenCalledTimes(4);
    for (const searchId of ["s-empty", "s-blank", "s-one", "s-nonstr"]) {
      expect(fake.searchReply).toHaveBeenCalledWith({
        searchId,
        tracks: [],
      });
    }
  });

  it("a failed search answers honestly empty — the guest sees no results, not a hang", async () => {
    const fake = makeFakeSearchTransport();
    const seam = makeFakeSeam({
      searchTracks: vi.fn(async () => {
        throw new Error("catalogue unreachable");
      }),
    });
    const bridge = createPartySearchBridge({
      transport: fake.transport,
      seam,
    });
    bridge.attach();
    fake.fireSearch({ searchId: "s-fail", query: "far" });
    await flush();
    expect(fake.searchReply).toHaveBeenCalledWith({
      searchId: "s-fail",
      tracks: [],
    });
  });

  it("identical in-flight queries share one seam call and every ask still gets its own reply", async () => {
    const fake = makeFakeSearchTransport();
    let release: ((tracks: ReturnType<typeof makeTrack>[]) => void) | null =
      null;
    const seam = makeFakeSeam({
      searchTracks: vi.fn(
        () =>
          new Promise<ReturnType<typeof makeTrack>[]>((resolve) => {
            release = resolve;
          }),
      ),
    });
    const bridge = createPartySearchBridge({
      transport: fake.transport,
      seam,
    });
    bridge.attach();
    fake.fireSearch({ searchId: "s-a", query: "far" });
    fake.fireSearch({ searchId: "s-b", query: "far" });
    expect(seam.searchTracks).toHaveBeenCalledTimes(1);
    release!([makeTrack("x1", "Far Song")]);
    await flush();
    expect(fake.searchReply).toHaveBeenCalledTimes(2);
    expect(fake.searchReply).toHaveBeenCalledWith({
      searchId: "s-a",
      tracks: [
        {
          id: "x1",
          title: "Far Song",
          artist: "Test Artist",
          source: "search",
        },
      ],
    });
    expect(fake.searchReply).toHaveBeenCalledWith({
      searchId: "s-b",
      tracks: [
        {
          id: "x1",
          title: "Far Song",
          artist: "Test Artist",
          source: "search",
        },
      ],
    });
    // A repeat of a finished query is served from the answer
    // cache — the seam is not hit again.
    fake.fireSearch({ searchId: "s-c", query: "far" });
    await flush();
    expect(seam.searchTracks).toHaveBeenCalledTimes(1);
    expect(fake.searchReply).toHaveBeenCalledWith({
      searchId: "s-c",
      tracks: [
        {
          id: "x1",
          title: "Far Song",
          artist: "Test Artist",
          source: "search",
        },
      ],
    });
  });

  it("is inert until attached, and detach unsubscribes — no leaked subscription", async () => {
    const fake = makeFakeSearchTransport();
    const seam = makeFakeSeam({
      searchTracks: vi.fn(async () => [makeTrack("x1", "Far Song")]),
    });
    const bridge = createPartySearchBridge({
      transport: fake.transport,
      seam,
    });
    expect(bridge.attached).toBe(false);
    fake.fireSearch({ searchId: "s0", query: "far" });
    await flush();
    expect(fake.searchReply).not.toHaveBeenCalled();

    const detach = bridge.attach();
    expect(bridge.attached).toBe(true);
    detach();
    expect(bridge.attached).toBe(false);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fake.hasListener()).toBe(false);
    fake.fireSearch({ searchId: "s1", query: "far" });
    await flush();
    expect(fake.searchReply).not.toHaveBeenCalled();
    expect(seam.searchTracks).not.toHaveBeenCalled();
  });
});

describe("partySearchBridge — resolution for out-of-queue arrivals", () => {
  it("resolves from tonight's search cache without a by-id lookup", async () => {
    const fake = makeFakeSearchTransport();
    const seam = makeFakeSeam({
      searchTracks: vi.fn(async () => [makeTrack("x1", "Far Song")]),
    });
    const bridge = createPartySearchBridge({
      transport: fake.transport,
      seam,
    });
    bridge.attach();
    fake.fireSearch({ searchId: "s1", query: "far" });
    await flush();
    const track = await bridge.resolveTrack("x1");
    expect(track?.id).toBe("x1");
    expect(track?.title).toBe("Far Song");
    expect(seam.getTrackById).not.toHaveBeenCalled();
  });

  it("falls back to the catalogue's by-id lookup and caches the result", async () => {
    const fake = makeFakeSearchTransport();
    const seam = makeFakeSeam({
      getTrackById: vi.fn(async (id: string) =>
        id === "x9" ? makeTrack("x9", "Looked Up") : null,
      ),
    });
    const bridge = createPartySearchBridge({
      transport: fake.transport,
      seam,
    });
    const track = await bridge.resolveTrack("x9");
    expect(track?.title).toBe("Looked Up");
    expect(seam.getTrackById).toHaveBeenCalledWith("x9");
    const again = await bridge.resolveTrack("x9");
    expect(again?.id).toBe("x9");
    expect(seam.getTrackById).toHaveBeenCalledTimes(1);
  });

  it("resolves null only when neither pool knows the id — including a throwing lookup", async () => {
    const fake = makeFakeSearchTransport();
    const seam = makeFakeSeam({
      getTrackById: vi.fn(async (id: string) => {
        if (id === "boom") throw new Error("lookup failed");
        return null;
      }),
    });
    const bridge = createPartySearchBridge({
      transport: fake.transport,
      seam,
    });
    expect(await bridge.resolveTrack("unknown-id")).toBeNull();
    expect(await bridge.resolveTrack("boom")).toBeNull();
    expect(await bridge.resolveTrack("")).toBeNull();
  });

  it("clear() drops the party's caches — yesterday's resolutions do not leak into tonight", async () => {
    const fake = makeFakeSearchTransport();
    const seam = makeFakeSeam({
      searchTracks: vi.fn(async () => [makeTrack("x1", "Far Song")]),
      getTrackById: vi.fn(async () => null),
    });
    const bridge = createPartySearchBridge({
      transport: fake.transport,
      seam,
    });
    bridge.attach();
    fake.fireSearch({ searchId: "s1", query: "far" });
    await flush();
    expect(bridge.cachedTrack("x1")?.title).toBe("Far Song");
    bridge.clear();
    expect(bridge.cachedTrack("x1")).toBeUndefined();
    expect(await bridge.resolveTrack("x1")).toBeNull();
    expect(seam.getTrackById).toHaveBeenCalledWith("x1");
  });
});
