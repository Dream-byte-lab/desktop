import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const startImport = vi.hoisted(() => vi.fn());

vi.mock("@/languages", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key}:${Object.values(vars).join("/")}` : key,
  }),
}));

vi.mock("@mingcute/react", () => ({
  PlaylistFill: () => null,
}));

vi.mock("@/shared/hooks", () => ({
  useTweenedNumber: (value: number) => value,
}));

vi.mock("@/shared/ui", () => ({
  SegmentBar: () => null,
}));

vi.mock("../store/modalStore", () => ({
  useModalStore: { getState: () => ({ openImportReview: vi.fn() }) },
}));

vi.mock("../store/importStore", () => ({
  useImportStore: {
    getState: () => ({ startImport, reviewItems: null, approvedTracks: null }),
  },
}));

import type { ImportJob } from "@/shared/contracts/imports";
import ImportingPlaylistCard from "./ImportingPlaylistCard";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(job: ImportJob) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(<ImportingPlaylistCard job={job} viewMode="list" />);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  startImport.mockReset();
});

const partialJob: ImportJob = {
  id: "job-1",
  source: "soundcloud",
  sourceUrl: "https://soundcloud.com/listener/likes",
  title: "listener — Likes",
  status: "completed",
  requiresDecision: false,
  playlistId: "pl_1",
  result: { total: 603, imported: 2, skipped: 601 },
  partial: {
    reason: "page_fetch_failed",
    missing: 601,
    expectedTotal: 603,
    resumable: true,
  },
  createdAt: new Date().toISOString(),
};

describe("ImportingPlaylistCard", () => {
  it("shows imported/expected counts and the shortfall for a partial import", () => {
    const el = render(partialJob);
    // The subtitle carries the partial string with the counts the
    // translator was handed: imported / total / missing.
    expect(el.textContent).toContain("import.status_partial_sub:2/603/601");
    expect(el.textContent).toContain("import.resume_action");
  });

  it("resumes the import from the same source when a partial card is clicked", () => {
    const el = render(partialJob);
    const clickable = el.firstElementChild as HTMLElement;
    act(() => {
      clickable.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(startImport).toHaveBeenCalledWith(partialJob.sourceUrl);
  });

  it("does not present a partial import as a clean complete", () => {
    const el = render(partialJob);
    expect(el.textContent).not.toContain("import.status_completed");
  });
});
