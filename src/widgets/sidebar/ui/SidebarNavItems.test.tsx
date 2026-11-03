import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { SidebarNavItems } from "./SidebarNavItems";
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

vi.mock("@/features/connectivity", () => ({
  useOfflineModeStore: (selector: any) => selector({ offline: false }),
}));

vi.mock("@/shared/ui", () => ({
  Tooltip: ({ children }: any) => <>{children}</>,
}));

describe("SidebarNavItems", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
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

  function renderNav() {
    act(() => {
      root?.render(
        <MemoryRouter initialEntries={["/"]}>
          <SidebarNavItems searchOpen={false} onSearchToggle={() => {}} />
        </MemoryRouter>,
      );
    });
  }

  it("renders section headers and honest links when expanded", () => {
    act(() => {
      useSidebarStore.setState({ collapsed: false });
    });
    renderNav();

    expect(container?.textContent).toContain("Discover");
    expect(container?.textContent).toContain("Your Collection");

    const forYou = container?.querySelector('a[href="/for-you"]');
    expect(forYou).not.toBeNull();
    expect(forYou?.textContent).toContain("For You");

    const favorites = container?.querySelector('a[href="/library/saved"]');
    expect(favorites).not.toBeNull();
    expect(favorites?.textContent).toContain("Favorites");

    const downloads = container?.querySelector('a[href="/library/cached"]');
    expect(downloads).not.toBeNull();
    expect(downloads?.textContent).toContain("Downloads");

    // Omitted entries render nowhere: no Radio / Your Mixes items, and
    // "Discover" appears only as the section header, never as a link.
    expect(container?.textContent).not.toContain("Radio");
    expect(container?.textContent).not.toContain("Your Mixes");
    const linkTexts = Array.from(container?.querySelectorAll("a") ?? []).map(
      (a) => a.textContent?.trim(),
    );
    expect(linkTexts).not.toContain("Discover");
    expect(linkTexts).not.toContain("Radio");
  });

  it("shows no section header text when collapsed", () => {
    act(() => {
      useSidebarStore.setState({ collapsed: true });
    });
    renderNav();

    expect(container?.textContent).not.toContain("Your Collection");
    expect(container?.textContent).not.toContain("Discover");
    expect(container?.textContent).not.toContain("Radio");
    expect(container?.textContent).not.toContain("Your Mixes");

    // The honest links still exist as rail capsules.
    expect(container?.querySelector('a[href="/for-you"]')).not.toBeNull();
    expect(container?.querySelector('a[href="/library/saved"]')).not.toBeNull();
    expect(
      container?.querySelector('a[href="/library/cached"]'),
    ).not.toBeNull();
  });
});
