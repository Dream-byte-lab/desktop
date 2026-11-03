import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/languages", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}:${Object.values(vars).join("/")}` : key,
  }),
}));

import PlaylistGenreEditor from "./PlaylistGenreEditor";
import { playlistGenreStore } from "@/features/genres/playlistGenreStore";

let container: HTMLDivElement;
let root: Root;

function buttons(): HTMLButtonElement[] {
  return [...document.querySelectorAll("button")];
}

function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((button) => button.textContent?.includes(text));
  if (!found) throw new Error(`no button containing "${text}"`);
  return found;
}

function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  playlistGenreStore.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  playlistGenreStore.clear();
});

describe("PlaylistGenreEditor", () => {
  it("mounts closed with an add-labels affordance and no chips", () => {
    act(() => {
      root.render(<PlaylistGenreEditor playlistId="editor-pl" />);
    });
    expect(document.body.textContent).toContain("genres.playlist_genre");
    expect(buttonByText("genres.add_labels")).toBeTruthy();
    expect(document.querySelector("input")).toBeNull();
  });

  it("adds a typed label, which lands in the overlay store and shows as a chip", () => {
    act(() => {
      root.render(<PlaylistGenreEditor playlistId="editor-pl" />);
    });
    click(buttonByText("genres.add_labels"));
    const input = document.querySelector("input")!;
    type(input, "Road Trip");
    click(buttonByText("genres.add"));
    expect(playlistGenreStore.labelsForPlaylist("editor-pl")).toEqual([
      "Road Trip",
    ]);
    expect(document.body.textContent).toContain("Road Trip");
  });

  it("offers the owner's existing labels as one-tap picks", () => {
    playlistGenreStore.addLabel("other-pl", "Known Word");
    act(() => {
      root.render(<PlaylistGenreEditor playlistId="editor-pl" />);
    });
    click(buttonByText("genres.add_labels"));
    click(buttonByText("Known Word"));
    expect(playlistGenreStore.labelsForPlaylist("editor-pl")).toEqual([
      "Known Word",
    ]);
    // the label now shows as a chip, and is not offered as a pick again
    expect(document.body.textContent).toContain("Known Word");
    expect(
      buttons().filter((button) => button.textContent?.includes("Known Word")),
    ).toHaveLength(0);
  });

  it("removes a label from the panel chips", () => {
    playlistGenreStore.addLabel("editor-pl", "Gym");
    act(() => {
      root.render(<PlaylistGenreEditor playlistId="editor-pl" />);
    });
    click(buttonByText("genres.edit_labels"));
    const remove = buttons().find(
      (button) =>
        button.getAttribute("aria-label") === "genres.remove_label:Gym",
    );
    if (!remove) throw new Error("no remove button for Gym");
    click(remove);
    expect(playlistGenreStore.labelsForPlaylist("editor-pl")).toEqual([]);
  });

  it("does not add a duplicate of a carried label", () => {
    playlistGenreStore.addLabel("editor-pl", "Gym");
    act(() => {
      root.render(<PlaylistGenreEditor playlistId="editor-pl" />);
    });
    click(buttonByText("genres.edit_labels"));
    const input = document.querySelector("input")!;
    type(input, " gym ");
    click(buttonByText("genres.add"));
    expect(playlistGenreStore.labelsForPlaylist("editor-pl")).toEqual(["Gym"]);
  });
});
