// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";
import SongCardWithMenu from "./SongCardWithMenu";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  liked: false,
  likeMutate: vi.fn(),
  unlikeMutate: vi.fn(),
}));

vi.mock("@/features/library", () => ({
  useIsTrackLiked: (id?: string) => (id ? mocks.liked : false),
  useLikeTrack: () => ({ mutate: mocks.likeMutate }),
  useUnlikeTrack: () => ({ mutate: mocks.unlikeMutate }),
}));

vi.mock("../hooks/useSongMenuItems", () => ({
  useSongMenuItems: () => [
    { id: "like-track", label: "Like", onClick: vi.fn() },
  ],
}));

vi.mock("../engine/playerEngine", () => ({
  playerEngine: { addToQueue: vi.fn() },
}));

vi.mock("../store/playerStore", () => ({
  usePlayerStore: (selector: (state: unknown) => unknown) =>
    selector({ trackDoubleClickBehavior: "play" }),
}));

vi.mock("@/shared/ui", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/languages", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        "common.like": "Like",
        "common.unlike": "Unlike",
        "common.more_options": "More options",
        "common.added_to_queue": "Added to queue",
      };
      return dict[key] || key;
    },
  }),
}));

vi.mock("@/features/artist", () => ({
  ArtistLink: ({ name }: { name?: string }) => <span>{name}</span>,
}));

vi.mock("@/features/covers/ui/CoverImage", () => ({
  default: () => null,
}));

vi.mock("@/features/covers/lib/coverArt", () => ({
  isCoverReady: () => true,
}));

vi.mock("@mingcute/react", () => ({
  More2Fill: () => <span data-icon="more" />,
  RepeatFill: () => <span data-icon="repeat" />,
  HeartFill: () => <span data-icon="heart-fill" />,
  HeartLine: () => <span data-icon="heart-line" />,
}));

describe("SongCardWithMenu one-click like heart", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    mocks.liked = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.removeChild(container);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderRow(
    props: Partial<React.ComponentProps<typeof SongCardWithMenu>> = {},
  ) {
    const onPlay = props.onPlay ?? vi.fn();
    act(() => {
      root.render(
        <SongCardWithMenu
          id="track-1"
          title="Song"
          artists="Artist"
          coverUrl=""
          {...props}
          onPlay={onPlay}
        />,
      );
    });
    return { onPlay };
  }

  const heartButton = () =>
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="Like"], button[aria-label="Unlike"]',
    );

  const click = (el: Element) => {
    act(() => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    act(() => {
      vi.advanceTimersByTime(300);
    });
  };

  it("shows an outlined heart labelled Like, unpressed, for an unliked cloud track", () => {
    renderRow();
    const heart = heartButton();
    expect(heart).not.toBeNull();
    expect(heart?.getAttribute("aria-label")).toBe("Like");
    expect(heart?.getAttribute("aria-pressed")).toBe("false");
    expect(heart?.getAttribute("title")).toBe("Like");
    expect(heart?.querySelector('[data-icon="heart-line"]')).not.toBeNull();
    expect(heart?.querySelector('[data-icon="heart-fill"]')).toBeNull();
  });

  it("shows a filled heart labelled Unlike, pressed, for a liked cloud track", () => {
    mocks.liked = true;
    renderRow();
    const heart = heartButton();
    expect(heart).not.toBeNull();
    expect(heart?.getAttribute("aria-label")).toBe("Unlike");
    expect(heart?.getAttribute("aria-pressed")).toBe("true");
    expect(heart?.querySelector('[data-icon="heart-fill"]')).not.toBeNull();
    expect(heart?.querySelector('[data-icon="heart-line"]')).toBeNull();
  });

  it("sits immediately to the right of the ⋮ button", () => {
    renderRow();
    const more = container.querySelector<HTMLButtonElement>(
      'button[aria-label="More options"]',
    );
    const heart = heartButton();
    expect(more).not.toBeNull();
    expect(heart).not.toBeNull();
    // Same trailing cluster, heart after the menu button in DOM order.
    expect(more?.parentElement?.parentElement).toBe(heart?.parentElement);
    expect(
      more!.compareDocumentPosition(heart!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("clicking the heart likes an unliked track and never starts playback", () => {
    const { onPlay } = renderRow();
    click(heartButton()!);
    expect(mocks.likeMutate).toHaveBeenCalledTimes(1);
    expect(mocks.likeMutate).toHaveBeenCalledWith("track-1");
    expect(mocks.unlikeMutate).not.toHaveBeenCalled();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("clicking the heart unlikes a liked track and never starts playback", () => {
    mocks.liked = true;
    const { onPlay } = renderRow();
    click(heartButton()!);
    expect(mocks.unlikeMutate).toHaveBeenCalledTimes(1);
    expect(mocks.unlikeMutate).toHaveBeenCalledWith("track-1");
    expect(mocks.likeMutate).not.toHaveBeenCalled();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("shows no heart for a local-device track, while the menu stays", () => {
    renderRow({ id: "local:file-1" });
    expect(heartButton()).toBeNull();
    expect(
      container.querySelector('button[aria-label="More options"]'),
    ).not.toBeNull();
  });

  it("shows no heart for a non-track row (album)", () => {
    renderRow({ searchType: "album" });
    expect(heartButton()).toBeNull();
  });

  it("still plays when the row itself is clicked", () => {
    const { onPlay } = renderRow();
    const row = container.querySelector("div.group");
    expect(row).not.toBeNull();
    click(row!);
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(mocks.likeMutate).not.toHaveBeenCalled();
    expect(mocks.unlikeMutate).not.toHaveBeenCalled();
  });

  it("Enter on the heart does not start playback; Enter on the row does", () => {
    const { onPlay } = renderRow();
    act(() => {
      heartButton()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onPlay).not.toHaveBeenCalled();

    const row = container.querySelector("div.group")!;
    act(() => {
      row.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onPlay).toHaveBeenCalledTimes(1);
  });
});
