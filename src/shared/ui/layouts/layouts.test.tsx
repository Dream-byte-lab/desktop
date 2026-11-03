import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import {
  EditorialLayout,
  GridLayout,
  ListLayout,
  ProfileLayout,
  SplitLayout,
  ImmersiveLayout,
} from "./index";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("Workspace layout primitives", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
  });

  it("Editorial renders hero before children and shows children", () => {
    act(() => {
      root?.render(
        <EditorialLayout hero={<div>editorial-hero</div>}>
          <div>editorial-body</div>
        </EditorialLayout>,
      );
    });
    expect(container?.textContent).toContain("editorial-hero");
    expect(container?.textContent).toContain("editorial-body");
    const text = container?.textContent ?? "";
    expect(text.indexOf("editorial-hero")).toBeLessThan(
      text.indexOf("editorial-body"),
    );
  });

  it("Grid renders children with the default minmax template", () => {
    act(() => {
      root?.render(
        <GridLayout>
          <div>grid-child</div>
        </GridLayout>,
      );
    });
    expect(container?.textContent).toContain("grid-child");
    const grid = container?.firstElementChild as HTMLElement | null;
    expect(grid?.style.gridTemplateColumns).toContain(
      "repeat(auto-fill, minmax(160px, 1fr))",
    );
  });

  it("Grid honours a custom minItemWidth", () => {
    act(() => {
      root?.render(
        <GridLayout minItemWidth={220}>
          <div>grid-wide</div>
        </GridLayout>,
      );
    });
    expect(container?.textContent).toContain("grid-wide");
    const grid = container?.firstElementChild as HTMLElement | null;
    expect(grid?.style.gridTemplateColumns).toContain(
      "repeat(auto-fill, minmax(220px, 1fr))",
    );
  });

  it("List renders children and applies dividers only when divided", () => {
    act(() => {
      root?.render(
        <ListLayout divided>
          <div>list-row</div>
        </ListLayout>,
      );
    });
    expect(container?.textContent).toContain("list-row");
    const list = container?.firstElementChild as HTMLElement | null;
    expect(list?.className).toContain("divide-y");
  });

  it("Profile renders header before children", () => {
    act(() => {
      root?.render(
        <ProfileLayout header={<div>profile-header</div>}>
          <div>profile-body</div>
        </ProfileLayout>,
      );
    });
    expect(container?.textContent).toContain("profile-header");
    expect(container?.textContent).toContain("profile-body");
    const text = container?.textContent ?? "";
    expect(text.indexOf("profile-header")).toBeLessThan(
      text.indexOf("profile-body"),
    );
  });

  it("Split renders main before aside", () => {
    act(() => {
      root?.render(
        <SplitLayout
          main={<div>split-main</div>}
          aside={<div>split-aside</div>}
        />,
      );
    });
    expect(container?.textContent).toContain("split-main");
    expect(container?.textContent).toContain("split-aside");
    const text = container?.textContent ?? "";
    expect(text.indexOf("split-main")).toBeLessThan(
      text.indexOf("split-aside"),
    );
  });

  it("Immersive renders children", () => {
    act(() => {
      root?.render(
        <ImmersiveLayout>
          <div>immersive-child</div>
        </ImmersiveLayout>,
      );
    });
    expect(container?.textContent).toContain("immersive-child");
  });
});
