import { describe, it, expect } from "vitest";
import { sidebarSections, sidebarAllItems, getSidebarItem } from "./navigation";

const ALLOWED_HREFS = new Set([
  "/",
  "/for-you",
  "/library",
  "/library/saved",
  "/library/cached",
]);

const OMITTED_IDS = [
  "discover",
  "radio",
  "recently-played",
  "songs",
  "albums",
  "artists",
  "playlists",
  "your-mixes",
  "listening-history",
  "personal-playlists",
  "profile",
];

describe("navigation honesty", () => {
  it("every href across sidebarSections resolves to a real route", () => {
    for (const section of sidebarSections) {
      for (const id of section.itemIds) {
        const item = getSidebarItem(id);
        expect(item, `missing item for id ${id}`).toBeDefined();
        if (item!.href) {
          expect(ALLOWED_HREFS.has(item!.href)).toBe(true);
        }
      }
    }
    // Also check all hrefs in the all-items record that are section members
    const sectionIds = new Set(sidebarSections.flatMap((s) => s.itemIds));
    for (const id of sectionIds) {
      const item = sidebarAllItems[id];
      if (item?.href) expect(ALLOWED_HREFS.has(item.href)).toBe(true);
    }
  });

  it("omitted ids appear nowhere in the section item ids", () => {
    const allIds = sidebarSections.flatMap((s) => s.itemIds);
    for (const omitted of OMITTED_IDS) {
      expect(allIds).not.toContain(omitted);
    }
  });

  it("search has no href", () => {
    const search = getSidebarItem("search");
    expect(search).toBeDefined();
    expect(search!.href).toBeUndefined();
  });

  it("sections are exactly discover + collection", () => {
    expect(sidebarSections.map((s) => s.id)).toEqual([
      "discover",
      "collection",
    ]);
    expect(sidebarSections[0].itemIds).toEqual(["home", "for_you", "search"]);
    expect(sidebarSections[1].itemIds).toEqual([
      "library",
      "favorites",
      "downloads",
    ]);
  });

  it("for you points at its real page", () => {
    expect(getSidebarItem("for_you")?.href).toBe("/for-you");
  });

  it("favorites and downloads point at their real pages", () => {
    expect(getSidebarItem("favorites")?.href).toBe("/library/saved");
    expect(getSidebarItem("downloads")?.href).toBe("/library/cached");
  });
});
