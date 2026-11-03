import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { useSidebarStore } from "../model/useSidebarStore";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("framer-motion", () => {
  const cache: Record<string, any> = {};
  return {
    AnimatePresence: ({ children }: any) => <>{children}</>,
    useReducedMotion: () => false,
    motion: new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (!cache[prop]) {
            cache[prop] = React.forwardRef(
              ({ children, className, style, ...props }: any, ref: any) => {
                const cleanProps = { ...props };
                delete cleanProps.layoutId;
                delete cleanProps.transition;
                return React.createElement(
                  prop,
                  { ref, className, style, ...cleanProps },
                  children,
                );
              },
            );
          }
          return cache[prop];
        },
      },
    ),
  };
});

vi.mock("@/languages", () => ({
  useTranslation: () => ({
    t: () => "",
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

vi.mock("@/shared/ui", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/features/covers/ui/CoverImage", () => ({
  default: ({ src, alt }: any) => <img src={src} alt={alt} />,
}));

// The pin set and the playlist summaries are controlled per test;
// the component must read both through Wave 3's own seams.
const mockState: {
  pinnedIds: string[];
  playlists: { id: string; title: string; coverUrl: string }[];
} = { pinnedIds: [], playlists: [] };

vi.mock("@/features/library/lib/playlistIdentity", () => ({
  usePinnedPlaylistIds: () => mockState.pinnedIds,
}));

vi.mock("@/features/library/hooks/usePlaylists", () => ({
  usePlaylistsList: () => ({
    data: { playlists: mockState.playlists, total: mockState.playlists.length },
    error: undefined,
    isLoading: false,
  }),
}));

import { SidebarPinnedPlaylists } from "./SidebarPinnedPlaylists";

const summary = (id: string, title: string) => ({
  id,
  title,
  coverUrl: `https://covers.example/${id}.jpg`,
});

describe("SidebarPinnedPlaylists", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
    mockState.pinnedIds = [];
    mockState.playlists = [];
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

  function renderPinned(route = "/") {
    act(() => {
      root?.render(
        <MemoryRouter initialEntries={[route]}>
          <SidebarPinnedPlaylists />
        </MemoryRouter>,
      );
    });
  }

  it("renders nothing when there are no pins", () => {
    act(() => {
      useSidebarStore.setState({ collapsed: false });
    });
    mockState.playlists = [summary("p1", "One")];
    renderPinned();
    expect(container?.textContent ?? "").toBe("");
  });

  it("renders nothing when no pin resolves to a real playlist", () => {
    act(() => {
      useSidebarStore.setState({ collapsed: false });
    });
    mockState.pinnedIds = ["gone", "likes"];
    mockState.playlists = [summary("p1", "One")];
    renderPinned();
    expect(container?.textContent ?? "").not.toContain("Pinned");
    expect(container?.querySelectorAll("a").length).toBe(0);
  });

  it("renders rows in pin order with covers, under the Pinned header", () => {
    act(() => {
      useSidebarStore.setState({ collapsed: false });
    });
    mockState.pinnedIds = ["p2", "p1"];
    mockState.playlists = [
      summary("p1", "First pinned later"),
      summary("p2", "Second pinned first"),
    ];
    renderPinned();

    expect(container?.textContent).toContain("Pinned");
    const links = Array.from(container?.querySelectorAll("a") ?? []);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/library/playlist?id=p2",
      "/library/playlist?id=p1",
    ]);
    expect(links[0].textContent).toContain("Second pinned first");
    expect(links[1].textContent).toContain("First pinned later");
    expect(
      container?.querySelector('img[src="https://covers.example/p2.jpg"]'),
    ).not.toBeNull();
  });

  it("marks the open playlist's row current, and only that row", () => {
    act(() => {
      useSidebarStore.setState({ collapsed: false });
    });
    mockState.pinnedIds = ["p1", "p2"];
    mockState.playlists = [summary("p1", "One"), summary("p2", "Two")];
    renderPinned("/library/playlist?id=p2");

    const links = Array.from(container?.querySelectorAll("a") ?? []);
    expect(links[0].getAttribute("aria-current")).toBeNull();
    expect(links[1].getAttribute("aria-current")).toBe("page");
  });

  it("in the rail it renders cover capsules named by their titles, with no header text", () => {
    act(() => {
      useSidebarStore.setState({ collapsed: true });
    });
    mockState.pinnedIds = ["p1"];
    mockState.playlists = [summary("p1", "Rail Mix")];
    renderPinned();

    expect(container?.textContent).not.toContain("Pinned");
    const link = container?.querySelector('a[href="/library/playlist?id=p1"]');
    expect(link).not.toBeNull();
    expect(link?.getAttribute("aria-label")).toBe("Rail Mix");
  });
});
