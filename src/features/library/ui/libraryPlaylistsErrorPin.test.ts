import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// S0 companion pins for the Library page's playlists load failure
// (Build 5 audit row 9): it used to render as a single teal
// caption with no way back. It now keeps its statement and gains
// a working Retry wired to the playlists load. (The retry's
// behaviour is pinned in hooks/usePlaylists.retry.test.tsx.)

function readSource(relativeUrl: string, treePath: string): string {
  const url = new URL(relativeUrl, import.meta.url);
  return url.protocol === "file:"
    ? readFileSync(url, "utf8")
    : readFileSync(path.resolve(process.cwd(), treePath), "utf8");
}

const pageSource = readSource(
  "./LibraryPage.tsx",
  "src/features/library/ui/LibraryPage.tsx",
);

describe("LibraryPage playlists load failure (S0 companion pins)", () => {
  it("keeps the failure statement", () => {
    expect(pageSource).toContain('t("playlist.error_loading")');
  });

  it("offers a retry wired to the playlists load", () => {
    expect(pageSource).toContain("retryPlaylistsLoad");
    expect(pageSource).toContain("onClick={handleRetryPlaylists}");
    expect(pageSource).toContain('t("library.playlists_retry")');
    expect(pageSource).toContain('t("library.playlists_retrying")');
  });

  it("the bare teal caption is gone", () => {
    expect(pageSource).not.toContain("text-caption text-accent-secondary");
  });
});
