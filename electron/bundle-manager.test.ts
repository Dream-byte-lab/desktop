import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ userData: "", appVersion: "0.1.35" }));

vi.mock("electron", () => ({
  app: { getPath: () => env.userData, getVersion: () => env.appVersion },
  BrowserWindow: class {},
}));

import {
  BUNDLE_UPDATES_DISABLED_FOR_LINERAVE,
  BundleManager,
  type BundleManifest,
} from "./bundle-manager";

// LINERAVE: upstream's version of this suite asserted the enabled OTA
// behaviour (silent download, install, hot-swap). This fork disables the
// bundle channel permanently (BUNDLE_UPDATES_DISABLED_FOR_LINERAVE,
// security audit SA-2 finding F1), so the suite now asserts refusal:
// even a perfectly valid, correctly signed bundle offer must change
// nothing. The harness below (real Ed25519 keys, real tarballs, a fake
// updater server) is kept on purpose — the refusal is only meaningful
// against an offer upstream's code would have accepted.

const UPDATER = "https://updates.test";
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const publicKeyHex = publicKey
  .export({ format: "der", type: "spki" })
  .toString("hex");

let root: string;
let builtInDist: string;

function makeBundle(
  version: string,
  signWith = privateKey,
): { manifest: BundleManifest; bytes: Buffer } {
  const work = fs.mkdtempSync(path.join(root, "src-"));
  fs.mkdirSync(path.join(work, "dist"));
  fs.writeFileSync(
    path.join(work, "dist", "index.html"),
    `<html>${version}</html>`,
  );
  const archive = path.join(work, "bundle.tar.gz");
  tar.create({ gzip: true, file: archive, cwd: work, sync: true }, ["dist"]);
  const bytes = fs.readFileSync(archive);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const signature = crypto
    .sign(null, Buffer.from(sha256, "utf8"), signWith)
    .toString("hex");
  return {
    bytes,
    manifest: {
      bundleVersion: version,
      minAppVersion: "0.1.35",
      channel: "stable",
      downloadUrl: `${UPDATER}/updates/bundles/bundle-${version}.tar.gz`,
      sha256,
      size: bytes.length,
      signature,
      releasedAt: new Date().toISOString(),
    },
  };
}

function serve(release: { manifest: BundleManifest; bytes: Buffer }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.startsWith(`${UPDATER}/updates/manifest.json`))
      return new Response(JSON.stringify(release.manifest));
    if (url === release.manifest.downloadUrl)
      return new Response(new Uint8Array(release.bytes));
    return new Response("not found", { status: 404 });
  });
}

function manager() {
  return new BundleManager({
    defaultRendererDist: builtInDist,
    updaterUrl: UPDATER,
    publicKeyHex,
  });
}

function runningHtml(bundles: BundleManager): string {
  return fs.readFileSync(bundles.getEffectiveIndexPath(), "utf8");
}

function stateFileExists(): boolean {
  return fs.existsSync(path.join(env.userData, "active_bundle.json"));
}

beforeEach(() => {
  env.appVersion = "0.1.35";
  root = fs.mkdtempSync(path.join(os.tmpdir(), "liner-bundles-"));
  env.userData = path.join(root, "userData");
  builtInDist = path.join(root, "built-in");
  fs.mkdirSync(builtInDist, { recursive: true });
  fs.writeFileSync(
    path.join(builtInDist, "index.html"),
    "<html>built-in</html>",
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("BundleManager (LINERAVE: OTA bundle channel disabled)", () => {
  it("keeps the LINERAVE disable switch on", () => {
    expect(BUNDLE_UPDATES_DISABLED_FOR_LINERAVE).toBe(true);
  });

  it("ignores a valid signed bundle offered at startup", async () => {
    const fetchSpy = serve(makeBundle("0.1.40"));
    const bundles = manager();
    await bundles.updateBeforeLaunch();
    expect(runningHtml(bundles)).toBe("<html>built-in</html>");
    expect(bundles.getActiveState()).toBeNull();
    expect(stateFileExists()).toBe(false);
    // the refusal happens before any network work at all
    expect(fetchSpy.mock.calls).toHaveLength(0);
  });

  it("refuses background checks without touching the network", async () => {
    const fetchSpy = serve(makeBundle("0.1.40"));
    const bundles = manager();
    expect(await bundles.checkForUpdates()).toEqual({
      available: false,
      reason: "Bundle updates are disabled in Linerave",
    });
    expect(await bundles.peekUpdate()).toEqual({ kind: "latest" });
    expect(fetchSpy.mock.calls).toHaveLength(0);
    expect(runningHtml(bundles)).toBe("<html>built-in</html>");
    expect(stateFileExists()).toBe(false);
  });

  it("refuses a direct downloadAndInstall of a valid manifest", async () => {
    const release = makeBundle("0.1.40");
    serve(release);
    const bundles = manager();
    expect(await bundles.downloadAndInstall(release.manifest)).toEqual({
      success: false,
      error: "Bundle updates are disabled in Linerave",
    });
    expect(fs.readdirSync(path.join(env.userData, "bundles"))).toEqual([]);
    expect(stateFileExists()).toBe(false);
    expect(runningHtml(bundles)).toBe("<html>built-in</html>");
  });

  it("never activates a bundle state file already on disk", () => {
    // A leftover active_bundle.json + bundle directory (e.g. planted or
    // inherited) satisfies every upstream activation check: the index
    // exists, minAppVersion is satisfied, bundleVersion >= appVersion.
    const bundleDir = path.join(env.userData, "bundles", "bundle-0.1.40-x");
    fs.mkdirSync(path.join(bundleDir, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(bundleDir, "dist", "index.html"),
      "<html>0.1.40</html>",
    );
    fs.writeFileSync(
      path.join(env.userData, "active_bundle.json"),
      JSON.stringify({
        bundleVersion: "0.1.40",
        bundleDir,
        installedAt: new Date().toISOString(),
        sha256: "deadbeef",
        minAppVersion: "0.1.0",
      }),
    );

    const bundles = manager();
    expect(bundles.getActiveState()).toBeNull();
    expect(bundles.getActiveVersion()).toBe("0.1.35");
    expect(runningHtml(bundles)).toBe("<html>built-in</html>");
  });

  it("refuses to hot-swap the running UI to a bundle", () => {
    const bundles = manager();
    expect(bundles.hotSwap()).toBe(false);
    expect(runningHtml(bundles)).toBe("<html>built-in</html>");
  });
});
