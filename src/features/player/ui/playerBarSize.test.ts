import { describe, it, expect, beforeEach } from "vitest";
import { resolveBarExpanded, usePlayerBarSizeStore } from "./playerBarSize";

describe("resolveBarExpanded", () => {
  it("pinned expanded wins with no contextual signal", () => {
    expect(
      resolveBarExpanded({
        pinned: "expanded",
        hovered: false,
        focusWithin: false,
        popupOpen: false,
      }),
    ).toBe(true);
  });

  it("pinned expanded wins with every contextual signal", () => {
    expect(
      resolveBarExpanded({
        pinned: "expanded",
        hovered: true,
        focusWithin: true,
        popupOpen: true,
      }),
    ).toBe(true);
  });

  it("pinned standard beats hover", () => {
    expect(
      resolveBarExpanded({
        pinned: "standard",
        hovered: true,
        focusWithin: false,
        popupOpen: false,
      }),
    ).toBe(false);
  });

  it("pinned standard beats focus-within and an open popup", () => {
    expect(
      resolveBarExpanded({
        pinned: "standard",
        hovered: false,
        focusWithin: true,
        popupOpen: true,
      }),
    ).toBe(false);
  });

  it("pinned standard stays standard with no signal", () => {
    expect(
      resolveBarExpanded({
        pinned: "standard",
        hovered: false,
        focusWithin: false,
        popupOpen: false,
      }),
    ).toBe(false);
  });

  it("unpinned is standard with no signal", () => {
    expect(
      resolveBarExpanded({
        pinned: null,
        hovered: false,
        focusWithin: false,
        popupOpen: false,
      }),
    ).toBe(false);
  });

  it("unpinned follows hover", () => {
    expect(
      resolveBarExpanded({
        pinned: null,
        hovered: true,
        focusWithin: false,
        popupOpen: false,
      }),
    ).toBe(true);
  });

  it("unpinned follows focus-within", () => {
    expect(
      resolveBarExpanded({
        pinned: null,
        hovered: false,
        focusWithin: true,
        popupOpen: false,
      }),
    ).toBe(true);
  });

  it("unpinned follows an open popup", () => {
    expect(
      resolveBarExpanded({
        pinned: null,
        hovered: false,
        focusWithin: false,
        popupOpen: true,
      }),
    ).toBe(true);
  });
});

describe("usePlayerBarSizeStore", () => {
  beforeEach(() => {
    localStorage.clear();
    usePlayerBarSizeStore.setState({ pinned: null });
  });

  it("defaults to unpinned (null)", () => {
    expect(usePlayerBarSizeStore.getState().pinned).toBeNull();
  });

  it("setPinned works", () => {
    usePlayerBarSizeStore.getState().setPinned("expanded");
    expect(usePlayerBarSizeStore.getState().pinned).toBe("expanded");
    usePlayerBarSizeStore.getState().setPinned("standard");
    expect(usePlayerBarSizeStore.getState().pinned).toBe("standard");
    usePlayerBarSizeStore.getState().setPinned(null);
    expect(usePlayerBarSizeStore.getState().pinned).toBeNull();
  });
});
