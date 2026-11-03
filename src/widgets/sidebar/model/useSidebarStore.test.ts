import { describe, it, expect, beforeEach } from "vitest";
import { useSidebarStore } from "./useSidebarStore";

describe("useSidebarStore", () => {
  beforeEach(() => {
    localStorage.clear();
    useSidebarStore.setState({ collapsed: false });
  });

  it("toggle flips collapsed", () => {
    expect(useSidebarStore.getState().collapsed).toBe(false);
    useSidebarStore.getState().toggle();
    expect(useSidebarStore.getState().collapsed).toBe(true);
    useSidebarStore.getState().toggle();
    expect(useSidebarStore.getState().collapsed).toBe(false);
  });

  it("setCollapsed works", () => {
    useSidebarStore.getState().setCollapsed(true);
    expect(useSidebarStore.getState().collapsed).toBe(true);
    useSidebarStore.getState().setCollapsed(false);
    expect(useSidebarStore.getState().collapsed).toBe(false);
  });
});
