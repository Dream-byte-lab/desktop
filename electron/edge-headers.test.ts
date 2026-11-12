import { describe, expect, it } from "vitest";
import {
  EDGE_REQUEST_URLS,
  isEdgeUrl,
  setEdgeKey,
  withEdgeHeaders,
} from "./edge-headers";

const KEY = "k".repeat(32);

describe("edge headers", () => {
  it("covers the api hosts over https only", () => {
    expect(isEdgeUrl("https://api.tryliner.fun/v1/me")).toBe(true);
    expect(isEdgeUrl("https://beta.tryliner.fun/health")).toBe(true);
    expect(isEdgeUrl("https://staging.tryliner.fun/v1/me")).toBe(true);
    expect(isEdgeUrl("http://api.tryliner.fun/v1/me")).toBe(false);
    expect(isEdgeUrl("https://link.tryliner.fun/track?id=x")).toBe(false);
    expect(isEdgeUrl("https://api.tryliner.fun.evil.example/")).toBe(false);
    expect(isEdgeUrl("not a url")).toBe(false);
  });

  it("adds the edge key and the clearance cookie, keeping what the request already sends", () => {
    const state = { key: KEY, clearance: "abc.def-123_456789" };
    expect(withEdgeHeaders({ Accept: "*/*" }, state)).toEqual({
      Accept: "*/*",
      "x-liner-edge": KEY,
      Cookie: "cf_clearance=abc.def-123_456789",
    });
    expect(
      withEdgeHeaders({ cookie: "a=1", "X-Liner-Edge": "own" }, state),
    ).toEqual({
      "X-Liner-Edge": "own",
      Cookie: "a=1; cf_clearance=abc.def-123_456789",
    });
    expect(
      withEdgeHeaders({ Cookie: "cf_clearance=already; b=2" }, state),
    ).toEqual({ Cookie: "cf_clearance=already; b=2", "x-liner-edge": KEY });
  });

  it("sends nothing it does not hold", () => {
    expect(withEdgeHeaders({ A: "1" }, { key: null, clearance: null })).toEqual(
      { A: "1" },
    );
  });

  it("takes only a well formed key", () => {
    setEdgeKey(KEY);
    expect(withEdgeHeaders({})["x-liner-edge"]).toBe(KEY);
    setEdgeKey("bad key with spaces");
    expect(withEdgeHeaders({})["x-liner-edge"]).toBeUndefined();
    setEdgeKey(KEY);
    setEdgeKey(null);
    expect(withEdgeHeaders({})["x-liner-edge"]).toBeUndefined();
  });
});

describe("playlists route parity", () => {
  it("routes the library's playlists request through the edge headers", () => {
    expect(EDGE_REQUEST_URLS).toEqual([
      "*://api.tryliner.fun/*",
      "*://beta.tryliner.fun/*",
      "*://staging.tryliner.fun/*",
    ]);
    expect(isEdgeUrl("https://api.tryliner.fun/v1/me/playlists")).toBe(true);
  });

  it("puts the full clearance material on a playlists request", () => {
    const state = { key: KEY, clearance: "abc.def-123_456789" };
    expect(withEdgeHeaders({}, state)).toEqual({
      "x-liner-edge": KEY,
      Cookie: "cf_clearance=abc.def-123_456789",
    });
  });
});
