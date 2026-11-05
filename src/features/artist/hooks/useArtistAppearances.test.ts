import { describe, expect, it, vi } from "vitest";

// The selector is pure; the api module is stubbed so the test
// stays hermetic (selectAppearances only needs toClientTrack).
vi.mock("@/shared/api", () => ({
  api: { search: vi.fn() },
  toClientTrack: (track: { id: string }) => ({ ...track }),
}));

import { selectAppearances } from "./useArtistAppearances";

// The derivation's honesty rule, pinned: a search result counts
// as an appearance ONLY when the catalogue itself credits this
// artist's id in a non-lead slot of the track's artist list.
// Lead billings are the artist's own tracks, name-only results
// carry no id credit, and non-track results never count — so the
// selector can understate but never invent.
describe("selectAppearances", () => {
  const trackItem = (id: string, artists: { id: string; name: string }[]) =>
    ({ type: "track", id, title: id, artists, durationMs: 1000 }) as any;

  it("keeps only non-lead id credits", () => {
    const items = [
      trackItem("own-lead", [
        { id: "art-1", name: "Main" },
        { id: "art-2", name: "Guest" },
      ]),
      trackItem("featured", [
        { id: "art-9", name: "Lead" },
        { id: "art-1", name: "Main" },
      ]),
      trackItem("co-billed", [
        { id: "art-9", name: "Lead" },
        { id: "art-8", name: "Other" },
        { id: "art-1", name: "Main" },
      ]),
      trackItem("no-credit", [{ id: "art-9", name: "Lead" }]),
      trackItem("id-less", [
        { id: "art-9", name: "Lead" },
        { id: "", name: "Main" },
      ]),
      { type: "artist", id: "art-1", name: "Main" } as any,
      { type: "album", id: "alb-1", title: "LP", artists: [] } as any,
    ];

    const selected = selectAppearances(items, "art-1");

    expect(selected.map((track) => track.id)).toEqual([
      "featured",
      "co-billed",
    ]);
  });

  it("returns nothing when the artist is never credited", () => {
    const items = [trackItem("someone-else", [{ id: "art-9", name: "Lead" }])];
    expect(selectAppearances(items, "art-1")).toEqual([]);
  });
});
