import { describe, it, expect, vi } from "vitest";
import {
  classifyCollectionLoadError,
  collectionLoadFailureHint,
} from "./collectionLoadError";
import { LocalMixNotFoundError } from "./localMixResolver";
import { ApiError } from "@/shared/api";

// The discrimination rule behind the collection page's honest
// terminal states: a rejection is a genuine not-found ONLY when
// it is the local mix resolver's named error or an ApiError 404.
// Everything else is a load failure (and earns a Retry).

vi.mock("@/shared/api", () => {
  class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError,
    api: {
      getPlaylist: vi.fn(),
      getAlbum: vi.fn(),
      getDailyMixes: vi.fn(),
      getHistory: vi.fn(),
    },
    getAuthSession: () => ({ user: { id: "user-1" } }),
    toClientTrack: (track: any) => track,
    mediaUrl: (url: string) => url,
  };
});

vi.mock("@/features/mixer/engine/tasteTracker", () => ({
  getTasteProfile: () => ({
    artists: {},
    tags: {},
    tracks: {},
    updatedAtMs: Date.now(),
  }),
}));

vi.mock("@/features/library/hooks", () => ({
  useLikedTracks: () => ({
    data: { tracks: [], total: 0 },
    isLoading: false,
    error: false,
  }),
  usePlaylistsList: () => ({
    data: { playlists: [], total: 0 },
    isLoading: false,
    error: undefined,
  }),
}));

vi.mock("@/features/library/hooks/useLikedTracks", () => ({
  likedTracksSnapshot: () => ({ tracks: [], fromServer: true }),
}));

vi.mock("@/features/genres/trackGenres", () => ({
  labelsForTrack: () => ({ playlistGenres: [], genres: [] }),
}));

vi.mock("@/shared/storage", () => ({
  linerDb: { getAnalysis: vi.fn(async () => null) },
}));

describe("classifyCollectionLoadError", () => {
  it("treats the local mix resolver's error as not-found", () => {
    expect(
      classifyCollectionLoadError(new LocalMixNotFoundError("mix:x")),
    ).toEqual({ kind: "not-found" });
  });

  it("treats an ApiError 404 as not-found", () => {
    expect(classifyCollectionLoadError(new ApiError(404, "Not found"))).toEqual(
      { kind: "not-found" },
    );
  });

  it("treats an ApiError 500 as a failure, keeping the cause", () => {
    const cause = new ApiError(500, "Server error");
    expect(classifyCollectionLoadError(cause)).toEqual({
      kind: "failed",
      cause,
    });
  });

  it("treats a non-404 ApiError (403) as a failure", () => {
    const cause = new ApiError(403, "Forbidden");
    expect(classifyCollectionLoadError(cause)).toEqual({
      kind: "failed",
      cause,
    });
  });

  it("treats the API layer's status-0 network error as a failure", () => {
    const cause = new ApiError(0, "Network error", "NETWORK_ERROR");
    expect(classifyCollectionLoadError(cause)).toEqual({
      kind: "failed",
      cause,
    });
  });

  it("treats a fetch TypeError as a failure", () => {
    const cause = new TypeError("Failed to fetch");
    expect(classifyCollectionLoadError(cause)).toEqual({
      kind: "failed",
      cause,
    });
  });

  it("treats any other rejection as a failure, cause preserved", () => {
    const cause = new Error("something else entirely");
    expect(classifyCollectionLoadError(cause)).toEqual({
      kind: "failed",
      cause,
    });
    expect(classifyCollectionLoadError("a string rejection")).toEqual({
      kind: "failed",
      cause: "a string rejection",
    });
  });
});

describe("collectionLoadFailureHint", () => {
  it("reads a 5xx answer as a server problem", () => {
    expect(collectionLoadFailureHint(new ApiError(500, "x"))).toBe("server");
    expect(collectionLoadFailureHint(new ApiError(503, "x"))).toBe("server");
  });

  it("reads a status-0 network error as a connection problem", () => {
    expect(collectionLoadFailureHint(new ApiError(0, "Network error"))).toBe(
      "offline",
    );
  });

  it("reads a fetch TypeError as a connection problem", () => {
    expect(collectionLoadFailureHint(new TypeError("Failed to fetch"))).toBe(
      "offline",
    );
  });

  it("proves nothing for other causes and offers no line", () => {
    expect(collectionLoadFailureHint(new ApiError(400, "Bad request"))).toBe(
      null,
    );
    expect(collectionLoadFailureHint(new ApiError(404, "Not found"))).toBe(
      null,
    );
    expect(collectionLoadFailureHint(new Error("weird"))).toBe(null);
    expect(collectionLoadFailureHint("boom")).toBe(null);
    expect(collectionLoadFailureHint(undefined)).toBe(null);
  });
});
