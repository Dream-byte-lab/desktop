// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import SongCard from "./SongCard";
import { useRomanizationStore } from "@/shared/text";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@mingcute/react", () => ({
  More2Fill: () => <span data-icon="more" />,
  RepeatFill: () => <span data-icon="repeat" />,
}));

vi.mock("@/shared/ui/DropdownMenu", () => ({
  default: () => null,
}));

vi.mock("@/languages", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/features/artist", () => ({
  ArtistLink: ({ name }: { name?: string }) => <span>{name}</span>,
}));

vi.mock("@/shared/ui/HighlightedText", () => ({
  default: ({ text }: { text: string }) => <>{text}</>,
}));

vi.mock("@/shared/ui/ExplicitBadge", () => ({
  default: () => null,
}));

vi.mock("@/features/covers/ui/CoverImage", () => ({
  default: () => null,
}));

vi.mock("@/features/covers/lib/coverArt", () => ({
  isCoverReady: () => true,
}));

describe("SongCard romanization (display-only secondary text)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    act(() => {
      useRomanizationStore.setState({ enabled: true });
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    act(() => {
      useRomanizationStore.setState({ enabled: true });
    });
  });

  it("shows romanized title and artist beside the untouched originals", () => {
    act(() =>
      root.render(<SongCard title="Москва" artists="Кино" coverUrl="" />),
    );
    // Originals stay primary and unchanged…
    expect(container.textContent).toContain("Москва");
    expect(container.textContent).toContain("Кино");
    // …with the romanization as secondary text beside them.
    expect(container.textContent).toContain("Moskva");
    expect(container.textContent).toContain("Kino");
  });

  it("shows no romanization when the toggle is off", () => {
    act(() => {
      useRomanizationStore.getState().setEnabled(false);
    });
    act(() =>
      root.render(<SongCard title="Москва" artists="Кино" coverUrl="" />),
    );
    expect(container.textContent).toContain("Москва");
    expect(container.textContent).not.toContain("Moskva");
    expect(container.textContent).not.toContain("Kino");
  });

  it("shows nothing extra for Latin names", () => {
    act(() =>
      root.render(
        <SongCard title="Moskva Nights" artists="Kino" coverUrl="" />,
      ),
    );
    expect(container.textContent).toContain("Moskva Nights");
    expect(container.querySelectorAll("span[data-romanization]")).toHaveLength(
      0,
    );
  });
});
