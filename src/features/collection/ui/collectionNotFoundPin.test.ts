import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// S0 pins for CollectionPage's terminal branch. The not-found
// presentation is pinned BYTE-FOR-BYTE at the source level: the
// Daily Mix day-rollover behaviour (Note 23) depends on a
// genuinely missing collection reading as this exact calm line,
// so the failure state had to be added AROUND it, not through
// it. (No page-render harness exists for this page; the hook
// states that drive the branch are pinned behaviourally in
// hooks/useCollection.error.test.tsx.)

function readSource(relativeUrl: string, treePath: string): string {
  const url = new URL(relativeUrl, import.meta.url);
  return url.protocol === "file:"
    ? readFileSync(url, "utf8")
    : readFileSync(path.resolve(process.cwd(), treePath), "utf8");
}

const pageSource = readSource(
  "./CollectionPage.tsx",
  "src/features/collection/ui/CollectionPage.tsx",
);
const hookSource = readSource(
  "../hooks/useCollection.ts",
  "src/features/collection/hooks/useCollection.ts",
);

const NOT_FOUND_BLOCK = [
  '      <div className="h-full w-full bg-transparent flex items-center justify-center">',
  '        <span className="text-text-secondary">{t("collection.not_found")}</span>',
  "      </div>",
].join("\n");

describe("CollectionPage terminal branch (S0 pins)", () => {
  it("keeps the not-found presentation byte-for-byte", () => {
    expect(pageSource).toContain(NOT_FOUND_BLOCK);
  });

  it("renders the failure treatment only for the failed kind, before the not-found fallthrough", () => {
    const failedBranch = pageSource.indexOf('error?.kind === "failed"');
    const notFound = pageSource.indexOf('t("collection.not_found")');
    expect(failedBranch).toBeGreaterThan(-1);
    expect(notFound).toBeGreaterThan(-1);
    expect(failedBranch).toBeLessThan(notFound);
    expect(pageSource).toContain('t("collection.load_failed")');
    expect(pageSource).toContain("onClick={refetch}");
    expect(pageSource).toContain('t("collection.retry")');
  });

  it("the hook classifies cold rejections and returns error + refetch", () => {
    expect(hookSource).toContain("classifyCollectionLoadError(err)");
    expect(hookSource).toContain("return { data, loading, error, refetch };");
  });
});
