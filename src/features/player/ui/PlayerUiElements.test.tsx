import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("framer-motion", () => {
  const cache: Record<string, any> = {};
  return {
    AnimatePresence: ({ children }: any) => <>{children}</>,
    motion: new Proxy(
      {},
      {
        get: (_target, prop: string) => {
          if (!cache[prop]) {
            cache[prop] = React.forwardRef(
              ({ children, className, style, ...props }: any, ref: any) => {
                const cleanProps = { ...props };
                delete cleanProps.layout;
                delete cleanProps.initial;
                delete cleanProps.animate;
                delete cleanProps.exit;
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
vi.mock("./VolumePicker", () => ({
  VolumePicker: () => <div data-testid="volume-picker" />,
}));
vi.mock("./FullscreenCoverArt", () => ({
  FullscreenCoverArt: () => <div data-testid="cover-art" />,
}));
vi.mock("./FullscreenTrackInfo", () => ({
  FullscreenTrackInfo: () => <div data-testid="track-info" />,
}));
vi.mock("./FullscreenTimeline", () => ({
  FullscreenTimeline: () => <div data-testid="timeline" />,
}));
vi.mock("./FullscreenTransportControls", () => ({
  FullscreenTransportControls: () => <div data-testid="transport" />,
}));
vi.mock("@/features/navigation/hooks/useWindowState", () => ({
  useWindowState: () => ({ isEdgeToEdge: false }),
}));
vi.mock("@/languages", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { PlayerUiElements } from "./PlayerUiElements";

describe("PlayerUiElements queue control", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const queueButton = () =>
    container.querySelector<HTMLButtonElement>(
      'button[aria-label="player.queue"]',
    );

  it("renders a queue button that fires onQueueToggle", () => {
    const onQueueToggle = vi.fn();
    act(() => root.render(<PlayerUiElements onQueueToggle={onQueueToggle} />));
    const button = queueButton();
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onQueueToggle).toHaveBeenCalledTimes(1);
  });

  it("marks the queue button pressed while the queue is open", () => {
    act(() =>
      root.render(<PlayerUiElements onQueueToggle={() => {}} queueOpen />),
    );
    expect(queueButton()!.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders no queue button without an onQueueToggle handler", () => {
    act(() => root.render(<PlayerUiElements />));
    expect(queueButton()).toBeNull();
  });
});
